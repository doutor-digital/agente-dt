import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { criarContextoPluggy, type ContextoPluggy } from './pluggy.js';
import { LEITURA_DO_RENDIMENTO, MAX_FICHAS, atribuirPix, montarPessoas, pluggyRendimentoSofia, registrarRendimentoSePermitido, type FontesDoRendimento } from './pluggy-rendimento.js';
import { entradasDoBanco, type PixRecebido } from '../lib/pix-casamento.js';
import type { ContaPluggy, FontePluggy, ItemConfigurado, ItemPluggy, LancamentoPluggy } from '../lib/integracoes/pluggy.js';

// nomes, ids e documentos INVENTADOS (o repositório é público)
const ITEM = 'a5c763cb-0952-457b-9936-630f79c5b016';
const AGORA = Date.parse('2026-11-26T15:00:00.000Z');
const itens: ItemConfigurado[] = [{ empresa: 'doutor-hernia-teste', nomeDaEmpresa: 'Teste', itemId: ITEM }];
const item: ItemPluggy = { id: ITEM, banco: 'InfinitePay', status: 'UPDATED', statusDaSincronizacao: 'SUCCESS', atualizadoEm: '2026-11-26T09:00:00.000Z', consentimentoExpiraEm: '2027-11-01T00:00:00.000Z', erroCodigo: null };
const conta: ContaPluggy = { id: 'cc1', tipo: 'BANK', subtipo: 'CHECKING_ACCOUNT', nome: 'Conta', numero: '1', saldo: 0, moeda: 'BRL' };
const lanc = (id: string, descricao: string, valor: number, o: Partial<LancamentoPluggy> = {}): LancamentoPluggy => ({
  id, data: '2026-11-10', descricao, valor, tipo: valor < 0 ? 'saida' : 'entrada', categoria: null, status: 'POSTED', ...o,
});

function ctxCom(lancamentos: LancamentoPluggy[], truncado = false): ContextoPluggy {
  const fonte: FontePluggy = {
    async item() { return item; },
    async contas() { return [conta]; },
    async transacoes() { return { lancamentos, truncado }; },
    async testar() {},
    invalidarItem() {},
  };
  return criarContextoPluggy(itens, fonte, { agora: () => AGORA });
}

const px = (id: string, nome: string, reais: number, o: Partial<PixRecebido> = {}): PixRecebido => ({ id, dia: '2026-11-10', centavos: Math.round(reais * 100), nomes: [nome], empresa: false, ...o });

const consultadosPorTelefone: string[][] = [];
const FONTES: FontesDoRendimento = {
  // conversas da Sofia SEM telefone (de qualquer data), pelo primeiro nome: há uma «Pedro» (e uma de uma palavra só, «Dona»)
  async primeirosNomesSemTelefone() {
    return new Set(['pedro', 'dona']);
  },
  // Joana: o telefone da ficha é o de conversa da Sofia → sofia. Paulo: ficha única, telefone sem nenhuma conversa dela → equipe COMPROVADA. Pedro: telefone sem conversa, MAS há conversa da
  // Sofia SEM telefone de nome parecido → não se prova. Carlos: sem ficha única/telefone → sem comprovação
  async origemPorTelefone(_empresa, nomes) {
    consultadosPorTelefone.push([...nomes].sort());
    const por: Record<string, 'sofia' | 'equipe' | 'desconhecido'> = { 'Joana Lima Pereira': 'sofia', 'Paulo Roberto Alves': 'equipe', 'Pedro Henrique Dias': 'equipe' };
    return new Map<string, 'sofia' | 'equipe' | 'desconhecido'>(nomes.map((n) => [n, por[n] ?? 'desconhecido']));
  },
  async agenda() {
    return {
      completa: true,
      pacientes: [
        { nome: 'MARIA DA CONCEICAO SILVA', idSchedule: 11 }, // a Sofia gravou esta marcação (certeza)
        { nome: 'Joana Lima Pereira', idSchedule: 12 }, // só o nome bate com uma conversa da Sofia
        { nome: 'Paulo Roberto Alves', idSchedule: 13 }, // equipe
        { nome: 'Ana Santos Costa', idSchedule: 14 }, // homônima de Ana Souza Costa: ambíguo
        { nome: 'Ana Souza Costa', idSchedule: 15 },
        { nome: 'Pedro Henrique Dias', idSchedule: 16 }, // só nome PARECIDO com conversa da Sofia: origem incerta
        { nome: 'Carlos Lima', idSchedule: 17 }, // equipe
        { nome: 'Carlos Lima', idSchedule: 18 }, // a mesma pessoa em outra marcação
        { nome: 'Maria', idSchedule: 19 }, // sem sobrenome: nunca casa
      ],
    };
  },
  async conversasDaSofia() {
    return [
      { nome: 'Maria Conceição Silva', marcou: true, idSchedule: 11 },
      { nome: 'Joana Alves Pereira', marcou: false, idSchedule: null }, // só o NOME bate com «Joana Lima Pereira»: não decide nada sozinho
      { nome: 'Pedro Dias Henr', marcou: false, idSchedule: null },
      { nome: 'Fulano Sem Agenda', marcou: false, idSchedule: null },
    ];
  },
};

const lancamentosDoMes = [
  lanc('p1', 'Pix MARIA CONCEICAO SILVA', 250, { pagadorTipoDocumento: 'PF' }), // sofia, marcada por ela
  lanc('p2', 'Pix JOANA LIMA PEREIRA', 150.5), // sofia (por nome)
  lanc('p3', 'Pix PAULO ROBERTO ALVES', 400), // equipe
  lanc('p4', 'Pix ANA COSTA', 250), // ambíguo
  lanc('p5', 'Pix PEDRO HENRIQUE DIAS', 100), // origem incerta
  lanc('p6', 'Pix CARLOS LIMA', 50), // equipe (a mesma pessoa, 2 marcações)
  lanc('p7', 'Pix FULANA PARENTE DE ALGUEM', 250), // sem paciente na agenda
  lanc('p8', 'Pix 12.345.678 CLINICA PARCEIRA LTDA', 900, { pagadorTipoDocumento: 'PJ' }), // empresa
  lanc('p9', 'Pix MARIA', 30), // sem sobrenome
  lanc('v1', 'Vendas Mastercard Crédito', 1200), // maquininha: agregada
  lanc('v2', 'Vendas Visa Débito', 300.4),
  lanc('t1', 'TED recebida ASSOCIACAO TESTE', 700),
  lanc('s1', 'Pix enviado FORNECEDOR', -500), // saída: fora
  lanc('x1', 'Pix JOANA LIMA PEREIRA', 80, { status: 'PENDING' }), // pendente: fora
];

test('quanto a Sofia rendeu: cada Pix vai para Sofia, equipe COMPROVADA ou «não atribuído» (com o motivo) e a soma dos três fecha com o que entrou; `leitura` vem primeiro', async () => {
  consultadosPorTelefone.length = 0;
  const r = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), FONTES, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(Object.keys(r)[0], 'leitura', 'a frase que impede a leitura errada é a PRIMEIRA chave da resposta');
  assert.equal(r.leitura, LEITURA_DO_RENDIMENTO);
  assert.match(r.leitura, /PISO comprovado/);
  assert.match(r.leitura, /conversou com a Sofia \(pelo menos 1 mensagem dela\), NÃO que ela causou o pagamento/);
  assert.match(r.leitura, /telefone compartilhado \(mãe e filha/);
  assert.match(r.leitura, /número FORTE é `numeroForte`/);
  assert.match(r.leitura, /não atribuído contém pacientes dela/);
  assert.match(r.leitura, /Sofia × equipe NÃO é comparável por este número/);
  assert.equal(Object.keys(r)[1], 'numeroForte', 'o número forte vem logo depois da leitura');
  assert.deepEqual(r.numeroForte, { descricao: 'consulta gravada pela Sofia', pacientes: 1, valor: 250 });
  assert.equal(r.nota.includes('nome igual'), false, 'a nota não diz mais que o nome decide');
  assert.match(r.nota, /o nome da conversa NÃO decide/);
  assert.equal(r.nota.startsWith(LEITURA_DO_RENDIMENTO), true, 'a mesma frase abre a nota');
  assert.equal(r.sofia.valor, 400.5);
  assert.equal(r.sofia.pix, 2);
  assert.equal(r.sofia.pacientes, 2);
  assert.deepEqual(r.sofia.dosQuaisMarcadosPelaSofia, { pacientes: 1, valor: 250 }, 'só a Maria teve a marcação gravada pela Sofia');
  assert.equal(r.equipeComprovada.valor, 400, 'só o Paulo: o Carlos não tem ficha com telefone e o Pedro tem conversa da Sofia SEM telefone de nome parecido');
  assert.equal(r.equipeComprovada.pix, 1);
  assert.equal(r.equipeComprovada.pacientes, 1);
  assert.deepEqual(consultadosPorTelefone, [['Carlos Lima', 'Joana Lima Pereira', 'Paulo Roberto Alves', 'Pedro Henrique Dias']], 'só os que receberam Pix de nome único e cuja marcação a Sofia NÃO gravou são conferidos por telefone');
  // não atribuído = ambíguo 250 + sem prova (Pedro 100 + Carlos 50) + sem paciente 250 + empresa 900 + sem sobrenome 30 + maquininha 1500,4 + TED 700
  assert.equal(r.naoAtribuido.valor, 250 + 150 + 250 + 900 + 30 + 1500.4 + 700);
  assert.equal(r.naoAtribuido.pix, 6);
  assert.deepEqual(r.naoAtribuido.motivosDosPix, {
    pixDeEmpresa: { pix: 1, valor: 900 },
    pixSemPacienteNaAgenda: { pix: 1, valor: 250 },
    pixComMaisDeUmPaciente: { pix: 1, valor: 250 },
    pixDePacienteSemOrigemComprovada: { pix: 2, valor: 150 },
    pixSemNome: { pix: 1, valor: 30 },
  });
  assert.deepEqual(r.naoAtribuido.vendasDeMaquininha, { lancamentos: 2, valor: 1500.4 });
  assert.deepEqual(r.naoAtribuido.outrasEntradas, { lancamentos: 1, valor: 700 });
  assert.equal(r.entrouNaConta.total, 4580.9);
  assert.equal(r.conferencia.igualAoQueEntrou, true);
  assert.equal(r.conferencia.somaDoExtrato, 4580.9, 'a soma do extrato é feita à parte, sem passar pela separação em Pix/maquininha/outras');
  assert.deepEqual(r.pacientesNaAgenda, { total: 7, sofia: 2, equipeComprovada: 1, origemSemComprovacao: 4 });
  assert.match(r.nota, /Limites/);
});

test('o paciente de APELIDO ou sem prova NÃO vira «equipe» nem «sofia»: sem a conferência por telefone só a marcação gravada pela Sofia conta; telefone que bate com conversa dela = Sofia', async () => {
  const semConferencia: FontesDoRendimento = { ...FONTES, origemPorTelefone: async () => { throw new Error('franquia fora'); } };
  const a = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), semConferencia, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(a.sofia.valor, 250, 'só a Maria (marcação gravada pela Sofia): o nome igual da Joana com uma conversa NÃO basta');
  assert.equal(a.equipeComprovada.valor, 0);
  assert.equal(a.naoAtribuido.motivosDosPix.pixDePacienteSemOrigemComprovada!.pix, 4, 'Joana, Paulo, Pedro e Carlos');
  assert.equal(a.conferencia.igualAoQueEntrou, true);
  const apelido: FontesDoRendimento = { ...FONTES, origemPorTelefone: async (_e, nomes) => new Map(nomes.map((n) => [n, n === 'Paulo Roberto Alves' ? 'sofia' : 'equipe'] as const)) };
  const b = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), apelido, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(b.sofia.valor, 650, 'Maria (marcação dela) + Paulo (a Sofia tinha conversa no telefone dele, no apelido)');
  assert.equal(b.equipeComprovada.valor, 200.5, 'Joana 150,5 + Carlos 50: telefone sem conversa; o Pedro NÃO entra: há conversa da Sofia sem telefone de nome parecido');
});

test('o botão «Marcar consulta» da EQUIPE grava o mesmo spine_id_schedule: só vale marcação com agendou_ia (o número forte não inclui consulta marcada pela recepção)', () => {
  const agenda = [{ nome: 'Rita Alves Souza', idSchedule: 50 }, { nome: 'Sara Lima Costa', idSchedule: 51 }];
  const conversas = [
    { nome: null, marcou: false, idSchedule: 50 }, // idSchedule preenchido, mas a Sofia NÃO marcou (foi a recepção)
    { nome: null, marcou: true, idSchedule: 51 },
  ];
  const pessoas = montarPessoas(agenda, conversas, new Set());
  assert.deepEqual(pessoas.map((p) => [p.nome, p.marcadaPelaSofia, p.origem]), [['Rita Alves Souza', false, 'semProva'], ['Sara Lima Costa', true, 'sofia']]);
});

test('«equipeComprovada» exige que NENHUMA conversa da Sofia sem telefone tenha o mesmo PRIMEIRO nome (nome de uma palavra só vale) e que a lista possa ser lida', async () => {
  const pessoas = montarPessoas([{ nome: 'Dona Maria Souza', idSchedule: 1 }, { nome: 'Ana Souza Lima', idSchedule: 2 }], [], new Set(['dona']));
  assert.deepEqual(pessoas.map((p) => [p.nome, p.suspeitaSemTelefone]), [['Dona Maria Souza', true], ['Ana Souza Lima', false]]);
  assert.deepEqual(montarPessoas([{ nome: 'Ana Souza Lima', idSchedule: 2 }], [], null).map((p) => p.suspeitaSemTelefone), [true], 'sem a leitura das conversas sem telefone, ninguém se prova «equipe»');
  // o telefone da Ana não tem fala da Sofia em data nenhuma → equipe; mas a lista não pôde ser lida → continua «não atribuído»
  const base: FontesDoRendimento = { ...FONTES, origemPorTelefone: async (_e, ns) => new Map(ns.map((n) => [n, 'equipe'] as const)) };
  const lido = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), base, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(lido.equipeComprovada.valor, 600.5, 'Joana 150,5 + Paulo 400 + Carlos 50; o Pedro tem conversa da Sofia sem telefone de mesmo primeiro nome e a Maria é Sofia (marcação dela)');
  const naoLido = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), { ...base, primeirosNomesSemTelefone: async () => null }, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(naoLido.equipeComprovada.valor, 0);
  const falhou = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), { ...base, primeirosNomesSemTelefone: async () => { throw new Error('banco fora'); } }, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(falhou.equipeComprovada.valor, 0);
});

test('o limite de conferências por telefone é VISÍVEL: quem passou do limite fica sem comprovação e a resposta diz quantos (e vem como incompleta)', async () => {
  const letras = (i: number) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + (Math.floor(i / 26) % 26));
  const nomes = Array.from({ length: MAX_FICHAS + 10 }, (_, i) => `Nome${letras(i)} Sobrenome${letras(i)}`.replace(/[^A-Za-z ]/g, ''));
  const lancs = nomes.map((n, i) => lanc(`q${i}`, `Pix ${n.toUpperCase()}`, 100));
  const pedidos: string[][] = [];
  const fontes: FontesDoRendimento = {
    agenda: async () => ({ completa: true, pacientes: nomes.map((nome, i) => ({ nome, idSchedule: 1000 + i })) }),
    conversasDaSofia: async () => [],
    primeirosNomesSemTelefone: async () => new Set<string>(),
    origemPorTelefone: async (_e, ns) => (pedidos.push(ns), new Map(ns.map((n) => [n, 'equipe'] as const))),
  };
  const r = await pluggyRendimentoSofia(ctxCom(lancs), fontes, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(pedidos[0]!.length, MAX_FICHAS);
  assert.equal(r.fichasNaoConferidas, 10);
  assert.equal(r.incompleto, true);
  assert.equal(r.equipeComprovada.pacientes, MAX_FICHAS);
  assert.equal(r.naoAtribuido.motivosDosPix.pixDePacienteSemOrigemComprovada!.pix, 10);
});

test('SEM NOME por padrão: nem nome, nem CPF, nem «detalhe» na resposta; com detalhar=true sai só o primeiro nome, o valor e o dia', async () => {
  const sem = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), FONTES, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  const txt = JSON.stringify(sem);
  for (const proibido of ['Maria', 'MARIA', 'Joana', 'Paulo', 'Carlos', 'Silva', 'Lima', 'documento', 'detalhe']) assert.equal(txt.includes(proibido), false, proibido);
  const com = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), FONTES, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25', detalhar: true });
  assert.deepEqual(com.detalhe!.map((d) => [d.grupo, d.paciente, d.valor]), [['sofia', 'Maria', 250], ['sofia', 'Joana', 150.5], ['equipe', 'Paulo', 400]]);
  const t2 = JSON.stringify(com);
  for (const proibido of ['Silva', 'Pereira', 'Alves', 'Conceição']) assert.equal(t2.includes(proibido), false, proibido);
});

test('nunca inventa atribuição: nome parecido, homônimo, sem sobrenome, origem incerta e empresa vão para «não atribuído»', () => {
  const pessoas = montarPessoas(
    [{ nome: 'Ana Santos Costa', idSchedule: 1 }, { nome: 'Ana Souza Costa', idSchedule: 2 }, { nome: 'Lia Barros Neves', idSchedule: 3 }, { nome: 'Rui Teles Mota', idSchedule: 4 }],
    [{ nome: 'Lia Barros Nev', marcou: false, idSchedule: null }],
    new Set(['lia', 'dona']), // conversas da Sofia sem telefone, por primeiro nome
  );
  // ninguém é «equipe» nem «sofia» só pelo nome; Lia tem conversa da Sofia SEM telefone de nome parecido (o telefone nunca provaria que ela não esteve lá)
  assert.deepEqual(pessoas.map((p) => [p.nome, p.origem, p.suspeitaSemTelefone]), [['Ana Santos Costa', 'semProva', false], ['Ana Souza Costa', 'semProva', false], ['Lia Barros Neves', 'semProva', true], ['Rui Teles Mota', 'semProva', false]]);
  pessoas.find((p) => p.nome === 'Rui Teles Mota')!.origem = 'equipe'; // a prova do telefone chegou para o Rui
  const a = atribuirPix([px('1', 'ANA COSTA', 100), px('2', 'RUI TELES MOTA', 50), px('3', 'RUI TELES MOTA', 10, { empresa: true }), px('4', 'LIA BARROS NEV', 70), px('5', 'RUI TELES', 5)], pessoas);
  assert.equal(a.equipe.centavos, 5000, 'só o Pix do Rui, de nome único e igual e origem comprovada');
  assert.equal(a.semDono.pix, 4);
  assert.equal(a.semDono.motivos.pixComMaisDeUmPaciente.pix, 1, 'Ana Santos Costa e Ana Souza Costa são ambíguas');
  assert.equal(a.semDono.motivos.pixDeEmpresa.pix, 1);
  assert.equal(a.semDono.motivos.pixNomeParecido.pix, 2, 'nome cortado ou sem o último nome: parecido não vale');
});

test('período: mais de 90 dias, datas ruins e empresa sem banco são recusados; falha na agenda ou nas conversas NÃO vira número', async () => {
  const c = ctxCom(lancamentosDoMes);
  await assert.rejects(() => pluggyRendimentoSofia(c, FONTES, { empresa: 'doutor-hernia-teste', inicio: '2026-06-01', fim: '2026-11-25' }), /até 90 dias/);
  await assert.rejects(() => pluggyRendimentoSofia(c, FONTES, { empresa: 'doutor-hernia-teste', inicio: '2026-11-25', fim: '2026-11-01' }), /início vem depois do fim/);
  await assert.rejects(() => pluggyRendimentoSofia(c, FONTES, { empresa: 'outra-empresa', inicio: '2026-11-01', fim: '2026-11-25' }), /sem leitura bancária/);
  await assert.rejects(() => pluggyRendimentoSofia(c, { ...FONTES, agenda: async () => null }, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' }), /não consegui ler a agenda/);
  await assert.rejects(() => pluggyRendimentoSofia(c, { ...FONTES, conversasDaSofia: async () => null }, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' }), /não consegui ler as conversas da Sofia/);
});

test('dado cortado (extrato truncado ou agenda cortada) vem marcado como INCOMPLETO', async () => {
  const cortadoNoBanco = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes, true), FONTES, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(cortadoNoBanco.incompleto, true);
  const cortadoNaAgenda = await pluggyRendimentoSofia(ctxCom(lancamentosDoMes), { ...FONTES, agenda: async () => ({ pacientes: [], completa: false }) }, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.equal(cortadoNaAgenda.incompleto, true);
  assert.equal(cortadoNaAgenda.agendaIncompleta, true);
});

test('a agenda é pedida com folga de 30 dias para os dois lados e as conversas desde 90 dias antes', async () => {
  const pedidos: string[] = [];
  const fontes: FontesDoRendimento = {
    agenda: async (e, de, ate) => (pedidos.push(`agenda ${e} ${de} ${ate}`), { pacientes: [], completa: true }),
    conversasDaSofia: async (e, de, ate) => (pedidos.push(`conversas ${e} ${de} ${ate}`), []),
    origemPorTelefone: async () => new Map(),
    primeirosNomesSemTelefone: async () => new Set<string>(),
  };
  await pluggyRendimentoSofia(ctxCom([]), fontes, { empresa: 'doutor-hernia-teste', inicio: '2026-11-01', fim: '2026-11-25' });
  assert.deepEqual(pedidos.sort(), ['agenda doutor-hernia-teste 2026-10-02 2026-12-25', 'conversas doutor-hernia-teste 2026-08-03 2026-11-25']);
});

// ------------------------------------------------------------------ permissão: só quem altera cartões

async function sessao(userId: string, escritores: Set<string>, contexto: ContextoPluggy, fontes: FontesDoRendimento | null = FONTES) {
  const server = new McpServer({ name: 't', version: '0' });
  const registrou = registrarRendimentoSePermitido(server, contexto, fontes, userId, escritores);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  const nomes = (await cliente.listTools().catch(() => ({ tools: [] }))).tools.map((t) => t.name);
  return { registrou, cliente, nomes };
}

test('PERMISSÃO: leitor comum não vê a ferramenta nem chamando direto; escritor vê, e ela é só de leitura; sem Pluggy ou sem fontes ninguém vê', async () => {
  const c = ctxCom(lancamentosDoMes);
  const leitor = await sessao('u-leitor', new Set(['u-joao']), c);
  assert.equal(leitor.registrou, false);
  assert.deepEqual(leitor.nomes, []);
  const direta = await leitor.cliente.callTool({ name: 'pluggy_rendimento_sofia', arguments: { inicio: '2026-11-01', fim: '2026-11-25' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal((direta as { isError?: boolean }).isError, true);
  assert.equal(JSON.stringify(direta).includes('400'), false);

  const escritor = await sessao('u-joao', new Set(['u-joao']), c);
  assert.equal(escritor.registrou, true);
  assert.deepEqual(escritor.nomes, ['pluggy_rendimento_sofia']);
  const tool = (await escritor.cliente.listTools()).tools[0]!;
  assert.equal(tool.annotations?.readOnlyHint, true);
  const resposta = await escritor.cliente.callTool({ name: 'pluggy_rendimento_sofia', arguments: { inicio: '2026-11-01', fim: '2026-11-25' } });
  const corpo = JSON.parse((resposta.content as Array<{ text: string }>)[0]!.text) as { sofia: { valor: number } };
  assert.equal(corpo.sofia.valor, 400.5, 'com uma só empresa com banco, ela é a padrão');

  assert.equal((await sessao('u-joao', new Set(['u-joao']), criarContextoPluggy([], null))).registrou, false, 'Pluggy desligada');
  assert.equal((await sessao('u-joao', new Set(['u-joao']), c, null)).registrou, false, 'sem as fontes (agenda e conversas)');
  assert.equal((await sessao('u-joao', new Set(), c)).registrou, false, 'sem MCP_ESCRITA_EMAILS ninguém vê');
});

test('entradas do banco somam por tipo (conferência do total)', () => {
  const e = entradasDoBanco(lancamentosDoMes);
  assert.equal(e.pix.length, 9);
  assert.equal(e.cartaoVendas.lancamentos, 2);
  assert.equal(e.outras.lancamentos, 1);
});

test('PERMISSÃO (fonte): producao.ts registra a ferramenta pelo MESMO grupo de quem altera cartões (nunca por uma lista nova) e uma vez só', () => {
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarRendimentoSePermitido\(/g)?.length, 1);
  assert.match(src, /registrarRendimentoSePermitido\(server, pluggy, fontesDoRendimentoReais\(\), quem\.userId, escritores, auditar\)/);
  assert.equal(/registrarRendimentoDaSofia\(/.test(src), false, 'o registro sem portão não é chamado de fora');
});
