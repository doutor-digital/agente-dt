/**
 * «Só agenda com sim»: a ferramenta de marcar da Sofia do CRM só grava se a última fala do paciente aceitou ESTE dia e ESTE horário.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Unit } from '@prisma/client';
import { aceitouEsteHorario, horariosCitados, recusaDeAceite } from './chatwoot-agenda-so-com-sim.js';
import { montarFerramentas, RastroEmMemoria, type DepsDasFerramentas, type EstadoDaRodada, type PortaDoChatwoot } from './chatwoot-sofia.js';
import type { SandboxAction } from '../controllers/playground.controller.js';
import type { Estado } from './automacoes-estado.js';

const u = (content: string) => ({ role: 'user' as const, content });
const s = (content: string) => ({ role: 'assistant' as const, content });
const ALVO = { data: '2026-11-26', hora: '14:00' }; // quinta-feira
const OFERTA_UNICA = s('Tenho quinta-feira, 26/11 às 14:00. Posso marcar?');
const OFERTA_LISTA = s('Tenho quinta, 26/11: 09:00, 14:00 ou 16:00. Qual prefere?');
const ok = (falas: Parameters<typeof aceitouEsteHorario>[0], alvo = ALVO, hoje: string | null = '2026-11-25') => aceitouEsteHorario(falas, alvo, hoje).ok;

test('horariosCitados: 14h, 14h30, 14:30, às 9, 2 da tarde; não confunde data nem valor', () => {
  assert.deepEqual([...horariosCitados('pode ser 14h ou 14h30, ou 9:15, ou às 16, ou 2 da tarde')].sort(), ['09:15', '14:00', '14:30', '16:00']);
  assert.deepEqual([...horariosCitados('dia 26/11, R$ 350, 12 sessões')], []);
});

test('«vou ver» e afins: NADA é marcado, mesmo com a oferta de um horário só na frente', () => {
  for (const fala of ['vou ver', 'Vou ver e te aviso', 'depois eu te confirmo', 'deixa eu pensar', 'talvez', 'preciso falar com meu marido', 'não sei', 'não', 'outro dia seria melhor', 'sim, mas onde fica?', 'acho que sim', 'vou ver se consigo quinta 14h']) {
    assert.equal(ok([OFERTA_UNICA, u(fala)]), false, fala);
  }
});

test('«sim» à oferta de UM horário igual ao da ferramenta: pode marcar', () => {
  for (const fala of ['sim', 'Sim!', 'pode', 'pode marcar', 'quero', 'fechado', 'ok', 'beleza', 'perfeito', 'isso mesmo', 'tá bom', 'bora']) {
    assert.equal(ok([OFERTA_UNICA, u(fala)]), true, fala);
  }
});

test('«sim» a uma LISTA de horários não escolhe nenhum; a oferta de outro horário/dia também não vale', () => {
  assert.equal(ok([OFERTA_LISTA, u('sim')]), false);
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 16:00. Posso marcar?'), u('sim')]), false, 'ofereceu 16h, a ferramenta ia gravar 14h');
  assert.equal(ok([s('Tenho sexta-feira, 27/11 às 14:00. Posso marcar?'), u('sim')]), false, 'ofereceu sexta, a ferramenta ia gravar quinta');
  assert.equal(ok([s('Tenho às 14:00. Posso marcar?'), u('sim')]), false, 'a oferta não disse o dia');
  assert.equal(ok([u('sim')]), false, 'sem oferta nenhuma');
});

test('o paciente nomeia o horário: vale se bate com a ferramenta (e com o dia, quando ele o disse)', () => {
  assert.equal(ok([OFERTA_LISTA, u('pode ser às 14h')]), true);
  assert.equal(ok([OFERTA_LISTA, u('quinta às 14h')]), true);
  assert.equal(ok([OFERTA_LISTA, u('quinta 14:00 por favor')]), true);
  assert.equal(ok([s('Qual dia e horário?'), u('amanhã às 14h')]), true, 'amanhã = 26/11 se hoje é 25/11');
  assert.equal(ok([s('Qual dia e horário?'), u('quinta, 26/11, às 14h')]), true);
  assert.equal(ok([OFERTA_LISTA, u('pode ser às 16h')]), false, 'escolheu outro horário');
  assert.equal(ok([OFERTA_LISTA, u('sexta às 14h')]), false, 'outro dia');
  assert.equal(ok([OFERTA_LISTA, u('27/11 às 14h')]), false);
  assert.equal(ok([s('Qual dia e horário?'), u('amanhã às 14h')], ALVO, '2026-11-20'), false, 'amanhã seria 21/11');
  assert.equal(ok([OFERTA_LISTA, u('às 14h e às 16h')]), false, 'dois horários');
  assert.equal(ok([s('Qual dia?'), u('às 14h')]), false, 'sem dia nem na fala nem na oferta');
  assert.equal(ok([OFERTA_LISTA, u('tem às 14h?')]), false, 'só perguntou se há');
  assert.equal(ok([OFERTA_LISTA, u('pode ser às 14h?')]), true);
});

test('última fala que não é do paciente: recusa; a recusa manda perguntar em uma frase e não afirma que marcou', () => {
  assert.equal(ok([u('sim'), s('Marcado?')]), false);
  const r = aceitouEsteHorario([OFERTA_UNICA, u('vou ver')], ALVO);
  assert.equal(r.ok, false);
  const texto = recusaDeAceite('agendar_consulta', r as { ok: false; motivo: string }, ALVO);
  assert.match(texto, /^RECUSADO: o paciente ainda não aceitou quinta-feira, 26\/11\/2026 às 14:00/);
  assert.match(texto, /NÃO foi marcada/);
  assert.match(texto, /Posso marcar quinta-feira, 26\/11\/2026 às 14:00\?/);
});

// ── rodada do sênior (#470): meia hora, bloqueios que passavam, «não» que não era do horário ────────────────────────

test('«às 14h30» é UM horário só (14:30), não dois: «sim» à oferta de 14h30 e «quinta às 9h30» valem', () => {
  assert.deepEqual([...horariosCitados('às 14h30')], ['14:30']);
  assert.deepEqual([...horariosCitados('quinta às 9h30, ou às 14h, ou às 9 da manhã')].sort(), ['09:00', '09:30', '14:00']);
  const a1430 = { data: '2026-11-26', hora: '14:30' };
  const a0930 = { data: '2026-11-26', hora: '09:30' };
  assert.equal(ok([s('Tenho quinta-feira, 26/11, às 14h30. Posso marcar?'), u('sim')], a1430), true, '«sim» à oferta às 14h30');
  assert.equal(ok([s('Tenho quinta-feira, 26/11, às 9h30. Posso marcar?'), u('sim')], a0930), true, '«sim» à oferta às 9h30');
  assert.equal(ok([s('Tenho quinta, 26/11: 9h30 ou 14h. Qual prefere?'), u('quinta às 9h30')], a0930), true, '«quinta às 9h30»');
  assert.equal(ok([s('Tenho quinta, 26/11: 9h30 ou 14h. Qual prefere?'), u('pode ser às 9h30')], a0930), true);
  assert.equal(ok([s('Tenho quinta, 26/11: 9h30 ou 14h. Qual prefere?'), u('quinta às 14h30')], a0930), false, 'outro horário continua recusando');
});

test('vira recusa: «vamos ver», «eu trabalho», «tenho médico», «esquece, deixa pra lá» depois do sim, «sim» a outra pergunta', () => {
  assert.equal(ok([OFERTA_UNICA, u('vamos ver')]), false, 'vamos ver');
  assert.equal(ok([OFERTA_LISTA, u('quinta às 14h eu trabalho')]), false, 'quinta às 14h eu trabalho');
  assert.equal(ok([OFERTA_LISTA, u('tenho médico quinta às 14h')]), false, 'tenho médico quinta às 14h');
  const pix = s('Pix antecipado ou pagar na clínica?');
  assert.equal(ok([OFERTA_UNICA, u('sim'), pix, u('esquece, deixa pra lá')]), false, 'desistiu depois do sim');
  assert.equal(ok([OFERTA_UNICA, u('sim'), pix, u('deixa quieto')]), false);
  assert.equal(ok([OFERTA_UNICA, u('sim'), pix, u('mudei de ideia')]), false);
  // a Sofia ofereceu o horário mas fechou com OUTRA pergunta: o «sim» responde a ela, não ao horário
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Você já é paciente?'), u('sim')]), false, 'sim à pergunta «já é paciente?»');
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Você já é paciente da clínica?'), u('sim')]), false);
  // e o que continua valendo
  assert.equal(ok([s('Você já é paciente? Tenho quinta-feira, 26/11 às 14:00. Posso marcar?'), u('sim')]), true, 'a última pergunta é a do horário');
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00, fecha?'), u('sim')]), true);
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00.'), u('sim')]), true, 'sem pergunta nenhuma: como antes');
  assert.equal(ok([OFERTA_LISTA, u('quinta às 14h, tô livre')]), true, 'frase de aceite com «livre» não é impedimento');
});

test('depois do «sim», o «não» de OUTRA pergunta e a data de nascimento NÃO desfazem o aceite; o «não» à vaga desfaz', () => {
  const paciente = s('Você já é paciente nosso?');
  assert.equal(ok([OFERTA_UNICA, u('sim'), paciente, u('não, primeira vez')]), true, 'não, primeira vez');
  assert.equal(ok([OFERTA_UNICA, u('sim'), paciente, u('ainda não')]), true, 'ainda não (sou paciente)');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Tem convênio?'), u('não tenho convênio')]), true, 'não tenho convênio');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Qual a sua data de nascimento?'), u('15/03/1980')]), true, 'nascimento 15/03/1980');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Data de nascimento?'), u('15/03/80')]), true, 'nascimento com ano de 2 dígitos');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Tem convênio?'), u('não'), s('E o CPF?'), u('123.456.789-00')]), true, 'não ao convênio + CPF');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Tem convênio?'), u('não tenho'), s('Seu nome completo?'), u('Maria da Silva')]), true);
  // o «não» que responde à vaga continua desfazendo
  assert.equal(ok([OFERTA_UNICA, u('não')]), false, 'não à oferta');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Só confirmando: quinta, 26/11 às 14:00. Posso marcar?'), u('não')]), false, 'não à pergunta do horário, depois do sim');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Pix ou na clínica?'), u('melhor às 16h')]), false, 'trocou o horário depois do sim');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Pix ou na clínica?'), u('melhor sexta')]), false, 'trocou o dia depois do sim');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Pix ou na clínica?'), u('vou ver')]), false, 'hesitou depois do sim');
});

// ── review do /code-review high (rodada 2): desistência com verbo, «nesse dia», data por extenso, fechamentos comuns, rajada ─────────

test('depois do «sim», desistir COM VERBO desfaz mesmo respondendo a outra pergunta («não quero mais», «não vou conseguir ir», «não sei se consigo»)', () => {
  const pix = s('Pix antecipado ou pagar na clínica?');
  for (const fala of ['não quero mais', 'não vou conseguir ir nesse dia', 'não posso', 'não dá', 'não sei se consigo chegar', 'ainda não sei se vou', 'não vai dar', 'cancela tudo']) {
    assert.equal(ok([OFERTA_UNICA, u('sim'), pix, u(fala)]), false, fala);
  }
  // e o «não» seco a OUTRA pergunta continua não desfazendo
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Tem convênio?'), u('não')]), true);
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Seu nome completo?'), u('Ana Cancela')]), true, 'sobrenome «Cancela» não é desistência');
});

test('«nesse dia eu trabalho» / «nesse horário tenho médico» depois do sim (sem hora nem dia na fala) desfazem; «eu trabalho» a «qual sua profissão?» não', () => {
  const pix = s('Pix ou clínica?');
  assert.equal(ok([OFERTA_UNICA, u('sim'), pix, u('nesse dia eu trabalho')]), false);
  assert.equal(ok([OFERTA_UNICA, u('sim'), pix, u('nesse horário tenho médico')]), false);
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Qual a sua profissão?'), u('eu trabalho numa loja')]), true);
});

test('data por extenso e endereço não são dia de consulta: «15 de março de 1980», «Rua 15 de Novembro, 120»', () => {
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Data de nascimento?'), u('15 de março de 1980')]), true);
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Qual o seu endereço?'), u('Rua 15 de Novembro, 120')]), true);
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Qual o seu endereço?'), u('Avenida 7 de Setembro, 45')]), true);
  assert.equal(ok([OFERTA_LISTA, u('27 de novembro às 14h')]), false, 'a data por extenso de consulta continua valendo');
});

test('fechamentos comuns da Sofia («Confirma?», «Tudo bem?», «Quer garantir essa vaga?», «Funciona pra você?») aceitam o «sim»; as de OUTRA coisa não', () => {
  for (const fim of ['Confirma?', 'Tudo bem?', 'Quer garantir essa vaga?', 'Funciona pra você?', 'Pode ser?', 'Fechado?']) {
    assert.equal(ok([s(`Tenho quinta-feira, 26/11 às 14:00. ${fim}`), u('sim')]), true, fim);
  }
  for (const fim of ['Você já é paciente da clínica?', 'Confirma o seu nome?', 'Tem convênio?', 'Qual o seu CPF?', 'Prefere pagar no Pix?']) {
    assert.equal(ok([s(`Tenho quinta-feira, 26/11 às 14:00. ${fim}`), u('sim')]), false, fim);
  }
});

test('rajada do paciente: o «não» sem mensagem da Sofia colada não sabe a que responde e retira (o lado seguro)', () => {
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Tem convênio?'), u('oi'), u('não')]), false);
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Tem convênio?'), u('não')]), true, 'colado na pergunta do convênio: segue valendo');
  assert.equal(ok([OFERTA_LISTA, u('cancela a outra e marca quinta às 14h')]), true, '«cancela a outra» num pedido de remarcação não é desistência');
});

// ── senior rodada 2 (#470): afirmativos de verdade, pergunta de marcar com nome/Pix, «trabalho»/«médico» como substantivo, «ok, obrigada», adiar ──────

test('afirmativos legítimos aceitam: «Simm», «siiim», «s», 👍, «show», «fica sim», «serve sim» (uma asserção por caso)', () => {
  for (const fala of ['Simm', 'siiim', 'SIMMMM!', 's', 'S', '👍', '👍🏽', 'show', 'show de bola', 'fica sim', 'serve sim', 'serve', 'dá sim', 'bacana', 'joia', 'top']) {
    assert.equal(ok([OFERTA_UNICA, u(fala)]), true, fala);
  }
  assert.equal(ok([OFERTA_UNICA, u('sim')]), true);
  // e os que NÃO são sim continuam fora
  for (const fala of ['sinto muito', 'sei lá', 'só se tiver desconto', 'sexta', 'si']) assert.equal(ok([OFERTA_UNICA, u(fala)]), false, fala);
});

test('a oferta fecha com «Posso marcar no seu nome?» ou com a pergunta de marcar seguida de uma frase de informação: o «sim» vale', () => {
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Posso marcar no seu nome?'), u('pode')]), true, 'Posso marcar no seu nome? + pode');
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Posso marcar no seu nome?'), u('sim')]), true);
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Posso marcar? O pagamento é no dia, em Pix, cartão ou dinheiro.'), u('sim')]), true, 'pergunta de marcar + informação depois');
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Posso marcar? Fica na Rua 15 de Novembro, perto do convênio.'), u('sim')]), true);
  // a pergunta de OUTRA coisa continua não aceitando
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Qual o seu nome?'), u('sim')]), false);
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Posso marcar? Você já é paciente da clínica?'), u('sim')]), false, 'a ÚLTIMA pergunta é a do paciente');
});

test('«trabalho» e «médico» só barram com verbo de impedimento: «é minha folga do trabalho» e «já tenho o pedido médico» são sim', () => {
  assert.equal(ok([OFERTA_LISTA, u('quinta 14h ótimo, é minha folga do trabalho')]), true, 'folga do trabalho');
  assert.equal(ok([OFERTA_LISTA, u('quinta às 14h, já tenho o pedido médico')]), true, 'pedido médico');
  // e o impedimento de verdade continua barrando
  for (const fala of ['quinta às 14h eu trabalho', 'tenho médico quinta às 14h', 'já tenho médico quinta às 14h', 'vou ter reunião nesse horário, quinta às 14h', 'quinta às 14h estou trabalhando', 'não posso quinta às 14h']) {
    assert.equal(ok([OFERTA_LISTA, u(fala)]), false, fala);
  }
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Pix ou clínica?'), u('nesse dia vou ter médico')]), false, 'depois do sim, «vou ter médico nesse dia»');
});

test('«ok, obrigada» agradece e «isso eu vejo depois» adia: nenhum é aceite; «ok» sozinho e «sim, obrigada» continuam sim', () => {
  for (const fala of ['ok, obrigada', 'Ok obrigado!', 'beleza, valeu', 'certo, obrigada', 'isso eu vejo depois', 'vejo isso depois', 'decido amanhã', 'depois a gente vê', 'depois eu falo com vocês']) {
    assert.equal(ok([OFERTA_UNICA, u(fala)]), false, fala);
  }
  for (const fala of ['ok', 'ok!', 'sim, obrigada', 'pode sim, obrigada', 'show, obrigada']) assert.equal(ok([OFERTA_UNICA, u(fala)]), true, fala);
});

// ── review do /code-review high (rodada 3) ─────────────────────────────────────────────────────────

test('impedimento dito de outro jeito continua barrando: «já tenho algo marcado», «trabalho às 14h», «trabalho quinta», «to no trabalho nesse horário»; «tem que ser quinta 14h» é pedido, não conflito', () => {
  for (const fala of ['quinta 14h já tenho algo marcado', 'quinta 14h já tenho outra coisa', 'quinta 14h, trabalho às 14h', 'quinta 14h trabalho quinta', 'quinta às 14h to no trabalho nesse horário', 'quinta 14h tenho que sair', 'quinta às 14h já estou ocupada']) {
    assert.equal(ok([OFERTA_LISTA, u(fala)]), false, fala);
  }
  assert.equal(ok([OFERTA_LISTA, u('pode marcar, tem que ser quinta 14h')]), true);
  assert.equal(ok([OFERTA_LISTA, u('quinta 14h, saio do trabalho às 13h')]), false, 'dois horários: lado seguro');
});

test('«Confirmo amanhã às 14h», «Pode marcar, depois eu levo os exames» e «Fechado, depois a gente acerta o pagamento» ACEITAM; adiar de verdade («depois eu vejo», «depois a gente vê») não', () => {
  const amanha = { data: '2026-11-26', hora: '14:00' };
  assert.equal(ok([s('Tenho amanhã às 14:00. Posso marcar?'), u('Confirmo amanhã às 14h')], amanha, '2026-11-25'), true, 'confirmo amanhã às 14h');
  assert.equal(ok([s('Tenho amanhã às 14:00. Posso marcar?'), u('retorno amanhã às 14h, pode marcar')], amanha, '2026-11-25'), true);
  assert.equal(ok([OFERTA_UNICA, u('Sim, pode marcar. Depois eu levo os exames')]), true);
  assert.equal(ok([OFERTA_UNICA, u('Fechado, depois a gente acerta o pagamento')]), true);
  for (const fala of ['depois eu vejo', 'depois eu te falo', 'depois a gente vê', 'depois a gente conversa']) assert.equal(ok([OFERTA_UNICA, u(fala)]), false, fala);
});

test('a pergunta sobre o HISTÓRICO («já foi agendado com a gente antes?») não é a de marcar; «Posso marcar com o Dr. João?» é', () => {
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Você já foi agendado com a gente antes?'), u('sim')]), false);
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Você já marcou aqui alguma vez?'), u('sim')]), false);
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00. Posso marcar com o Dr. João?'), u('sim')]), true);
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00 com a Dra. Ana. Posso marcar?'), u('pode')]), true);
});

test('um «s» solto no meio do texto NÃO é «sim»: só vale a fala inteira «s»', () => {
  assert.equal(ok([OFERTA_LISTA, u('quinta 14h tem vaga? s')]), false, 'pergunta');
  assert.equal(ok([OFERTA_UNICA, u('Rua S. João, 120')]), false);
  assert.equal(ok([OFERTA_UNICA, u('s')]), true);
  assert.equal(ok([OFERTA_UNICA, u(' S! ')]), true);
});

// ── a ferramenta ───────────────────────────────────────────────────────────────────────────────────

const unit = { id: 'u', slug: 'doutor-hernia-parauapebas', name: 'Clínica', category: 'saude', sourceProdutos: '', systemPrompt: '', businessHoursTimezone: 'America/Sao_Paulo' } as unknown as Unit;
const chat: PortaDoChatwoot = {
  conversa: async () => null,
  gravarAtributos: async () => {},
  adicionarEtiquetas: async () => {},
  nota: async () => {},
  publica: async () => ({ usuario: null }),
  valoresDoAtributo: async () => [],
  etiquetasDaConta: async () => [],
};

function ferramentas(falas: Array<{ role: 'user' | 'assistant'; content: string }>, soComSim: Estado | undefined) {
  const chamadas: string[] = [];
  const mk = (nome: string, devolve: string) =>
    new DynamicStructuredTool({ name: nome, description: nome, schema: z.object({ data: z.string().optional(), hora: z.string().optional(), leadId: z.number().optional() }), func: async () => (chamadas.push(nome), devolve) });
  const deps: DepsDasFerramentas = {
    construirAgenda: () => ({
      consultar_horarios: mk('consultar_horarios', 'Horários: 14:00'),
      buscar_paciente: mk('buscar_paciente', 'nenhum'),
      cadastrar_paciente: mk('cadastrar_paciente', 'Cadastrado. idClient 5'),
      agendar_consulta: mk('agendar_consulta', 'Consulta marcada para quinta-feira, 26 de novembro às 14:00.'),
      remarcar_consulta: mk('remarcar_consulta', 'Consulta remarcada de x para y'),
      cancelar_consulta: mk('cancelar_consulta', 'cancelada'),
    }),
    contaDividida: async () => null,
    grade: async () => ({ erro: null, slots: [{ time: '14:00', status: 'livre' }] }),
    consulta: async () => null,
  };
  const acoes: SandboxAction[] = [];
  const estado: EstadoDaRodada = { etapa: '', agendou: null, passouParaEquipe: false };
  const tools = montarFerramentas({ unit, modo: 'ligado', conversa: 5, telefone: '+5594999990000', chat, recorder: new RastroEmMemoria('cw-5-t', 'u'), estado, onCall: (a) => acoes.push(a), deps, falas, soComSim, agora: () => new Date('2026-11-25T15:00:00Z') });
  const chamar = async (nome: string, args: Record<string, unknown>) => String(await (tools.find((t) => t.name === nome) as unknown as { invoke: (a: unknown) => Promise<string> }).invoke(args));
  return { chamar, chamadas, acoes, estado };
}

test('o aceite vale até a ferramenta ser chamada: «sim», depois a forma de pagamento, o nome, o CPF — nada disso desfaz; «vou ver» no meio desfaz', () => {
  const pergunta = s('Prefere Pix antecipado ou pagar na clínica?');
  assert.equal(ok([OFERTA_UNICA, u('sim'), pergunta, u('na clínica')]), true);
  assert.equal(ok([OFERTA_UNICA, u('sim'), pergunta, u('na clínica'), s('Seu nome completo?'), u('Maria da Silva'), s('E o CPF?'), u('123.456.789-00')]), true);
  assert.equal(ok([OFERTA_UNICA, u('sim'), pergunta, u('vou ver')]), false, 'retirou depois');
  assert.equal(ok([OFERTA_UNICA, u('sim'), pergunta, u('na clínica'), s('Nome?'), u('Maria'), s('CPF?'), u('123'), s('Telefone?'), u('5594')]), false, 'o sim ficou longe demais (mais de 4 falas dele)');
  assert.equal(ok([OFERTA_UNICA, u('sim'), s('Quer saber o valor?'), u('quanto custa?')]), false, 'perguntou o valor: confirme depois de responder');
});

test('«sim» que vem com pergunta, pedido de informação ou fala longa não é aceite', () => {
  for (const fala of ['ok, e onde fica a clínica?', 'quero saber o valor', 'sim\ne quanto custa?', 'sim, mas qual o endereço', 'claro, preciso levar algum exame?', 'sim quero marcar mas só se tiver estacionamento perto da clínica ok']) {
    assert.equal(ok([OFERTA_UNICA, u(fala)]), false, fala);
  }
  for (const fala of ['sem dúvida, pode marcar!', 'sim, não tenho problema', 'ok, perfeito', 'Sim pode marcar sim', 'pode marcar, ainda bem que tem']) {
    assert.equal(ok([OFERTA_UNICA, u(fala)]), true, fala);
  }
});

test('outro dia escrito como «dia 27» ou «27 de novembro», e horário que não é a escolha («saio do trabalho às 14h»', () => {
  assert.equal(ok([OFERTA_LISTA, u('dia 27 às 14h')]), false);
  assert.equal(ok([OFERTA_LISTA, u('27 de novembro às 14h')]), false);
  assert.equal(ok([OFERTA_LISTA, u('dia 26 às 14h')]), true);
  assert.equal(ok([OFERTA_LISTA, u('26 de novembro às 14h')]), true);
  assert.equal(ok([OFERTA_LISTA, u('saio do trabalho às 14h')]), false);
  assert.equal(ok([OFERTA_LISTA, u('só consigo depois das 14h')]), false);
});

test('horário na oferta da Sofia não se confunde com «12 sessões» nem com «2 horário»', () => {
  assert.deepEqual([...horariosCitados('quinta 26/11 às 14:00 (são as 12 sessões do tratamento) e 3 horários')], ['14:00']);
  assert.equal(ok([s('Tenho quinta-feira, 26/11 às 14:00 (são as 12 sessões do tratamento). Posso marcar?'), u('sim')]), true);
});

test('LIGADA: paciente diz «vou ver» → agendar_consulta NÃO grava, devolve RECUSADO e a rodada não conta consulta marcada', async () => {
  const f = ferramentas([OFERTA_UNICA, u('vou ver')], 'ligado');
  const r = await f.chamar('agendar_consulta', { idClient: 5, ...ALVO, formaPagamento: 'na_clinica', diaConfirmado: true });
  assert.match(r, /^RECUSADO: o paciente ainda não aceitou/);
  assert.deepEqual(f.chamadas, [], 'a ferramenta real nem foi chamada: nada gravado na franquia');
  assert.equal(f.estado.agendou, null);
  assert.equal(f.acoes.some((a) => a.tool === 'gravar_no_chatwoot'), false);
  const rr = await f.chamar('remarcar_consulta', { ...ALVO });
  assert.match(rr, /^RECUSADO/);
  assert.deepEqual(f.chamadas, []);
});

test('LIGADA: paciente diz «sim» à oferta do mesmo horário → grava', async () => {
  const f = ferramentas([OFERTA_UNICA, u('sim')], 'ligado');
  const r = await f.chamar('agendar_consulta', { idClient: 5, ...ALVO, formaPagamento: 'na_clinica', diaConfirmado: true });
  assert.match(r, /^Consulta marcada/);
  assert.deepEqual(f.chamadas, ['agendar_consulta']);
  assert.deepEqual(f.estado.agendou, ALVO);
});

test('DESLIGADA (o padrão): nada muda, nem com «vou ver» — o comportamento de hoje, byte a byte', async () => {
  for (const estado of ['desligado' as const]) {
    const f = ferramentas([OFERTA_UNICA, u('vou ver')], estado);
    const r = await f.chamar('agendar_consulta', { idClient: 5, ...ALVO, formaPagamento: 'na_clinica', diaConfirmado: true });
    assert.match(r, /^Consulta marcada/);
    assert.deepEqual(f.chamadas, ['agendar_consulta']);
  }
});

test('SECO: não bloqueia (deixa passar como hoje); só anota o que bloquearia', async () => {
  const f = ferramentas([OFERTA_UNICA, u('vou ver')], 'seco');
  const r = await f.chamar('agendar_consulta', { idClient: 5, ...ALVO, formaPagamento: 'na_clinica', diaConfirmado: true });
  assert.match(r, /^Consulta marcada/);
  assert.deepEqual(f.chamadas, ['agendar_consulta']);
});

test('as outras ferramentas (horários, busca, cadastro, cancelamento) nunca passam pela trava', async () => {
  const f = ferramentas([u('vou ver')], 'ligado');
  await f.chamar('consultar_horarios', { data: ALVO.data });
  await f.chamar('buscar_paciente', {});
  await f.chamar('cancelar_consulta', {});
  assert.deepEqual(f.chamadas, ['consultar_horarios', 'buscar_paciente', 'cancelar_consulta']);
});
