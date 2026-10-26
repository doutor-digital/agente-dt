import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  abrirTarefaDaDesistencia,
  consultaFuturaDoCartao,
  textoTarefaDesistenciaSemIA,
  type DepsDaDesistencia,
  type KommoDaDesistencia,
} from './desistencia-da-consulta.js';
import { pareceDesistenciaDaConsulta } from './desistencia-frases.js';

// Frases REAIS dos pacientes (45 dias de `messages`, 26/10/2026) — o regex foi escrito depois de ler estas.
const DESISTIU = [
  'Cancelei.',
  'Eu cancelei',
  'Poder cancelar por favor',
  'Pode cancelar',
  'Estou  cancelando a consulta',
  'Quero cancelar a consulta marcada ontem',
  'Por favor, desmarca minha sessão hoje',
  'Vamos desmarcar então',
  'Oi bom dia gostaria de desmarcar a minha consulta',
  'Bom dia, pode desmarcar porque não vai ter como eu ir', // Araguaína #28858170
  'Boa tarde! Pode desmarcar, não vai dar para ir não consigo sair para levá-la',
  'Oi, hj infelizmente vou ter que desmarcar ,pois a minha filha terá uma audiência',
  'Oi eu mandei mensagem pra Suzane eu vou ter que desistir da vaga, tive um grande imprevisto infelizmente',
  'Não vou poder comparecer e encontrei uma clínica de FISIO que aceita o plano',
  'Não vou conseguir comparecer',
  'Não poderei ir',
  'Não vou poder ir amanhã',
  'Boa noite , não vou poder comparecer amanhã',
  'Hoje eu não consigo ir',
  'Não posso ir agora',
  'Se for hoje eu não posso ir',
  'Sim  só está semana  não vou poder estar aí',
  'Boa noite minha princesa na segunda não vai dar pra mim estar na consulta você pode ver um outro horário',
  'Não vai dar pra mim ir hoje',
  'Não vai dar para ir hoje',
  'Não vai dar eu ir hoje às 18',
  'Tive um imprevisto',
  'Aconteceu um imprevisto, não vou poder ir amanhã',
  'Boa tarde Tive um imprevisto e terei que viajar para São Paulo hj a tarde.',
  'Boa tarde ouve um imprevisto não vou conseguir ir gostaria de remarcar obrigada',
  'Nao irei',
  'Infelizmente nao irei.',
  'Não irei precisar mais',
  'n vou poder ir',
  // achados da 2ª revisão: a pergunta de reagendamento junto não anula o aviso
  'Não vou poder ir amanhã, posso outro dia?',
  'não vou conseguir ir, pode remarcar?',
  'Preciso cancelar, tem como?',
  'nao vou conseguir ir terça tem quinta?',
  'Pode cancelar? Não vou poder ir.',
  'Infelizmente não vou poder',
  'não tenho como ir',
  'Não vou poder ir amanhã\nPode me ajudar a remarcar?', // WhatsApp em duas linhas
];

// Frases reais que NÃO são desistência da consulta.
const NAO_DESISTIU = [
  'Segue o print para que o senhor verifique o cancelamento.',
  'esses casos de cancelamento de contrato manda no grupo do caixa e marca o financeiro e Dr Thiago',
  'Assinei a solicitação de cancelamento',
  'Não, pq não irei pagar a mais',
  'Hj não irei pra o pilates às 14:30',
  'Não Vai dar pra esse mês só no outro. Pode ser?',
  'Não vai dar não',
  'Não vai dar porque eu achei que vcs trabalhava com convênio',
  'Desculpa mas  imprevistos  acontecem',
  'Não tem problema com relação a imprevistos!  Vou dar uma checada aqui na minha agenda e já te informo!',
  'No momento não vou conseguir particular',
  'eu tenho plano de saude, no momento não vou poder pagar',
  'Marcaram esses momentos cancelaram eu que eu não posso que eu sou tenho uma carta faturada ok',
  'se vcs não mandar o Pix antes para mim pagar, eu não irei a consulta na segunda feira ok',
  // achados da revisão (26/10): negado, pergunta, condicional, outra coisa cancelada, vem em outro dia
  'Não quero cancelar',
  'não cancele minha consulta',
  'posso cancelar?',
  'Se eu cancelar, perco o valor?',
  'não vou desistir',
  'Vou sim, não vou desmarcar',
  'Como faço para cancelar o convênio?',
  'cancelei meu plano de saúde',
  'Quero cancelar o tratamento',
  'cancela o boleto por favor',
  'Cancela o lembrete, eu vou',
  'Desmarquei o dentista pra ir aí',
  'não vou ir de carro, vou de ônibus',
  'tive um imprevisto mas chego 15 min atrasada',
  'cancelei a consulta com outro médico, vou ficar com vocês',
  'o boleto não vai chegar a tempo',
  'o resultado do exame não vai chegar hoje',
  'Nao posso ir na quinta mas vou na sexta',
  'Bom dia, tudo bem? Quero marcar uma consulta',
  'Qual o valor da consulta?',
  'Sim, confirmo',
  '',
];

test('desistência da consulta: as frases reais de quem não vem', () => {
  for (const t of DESISTIU) assert.ok(pareceDesistenciaDaConsulta(t), `deveria pegar: ${t}`);
});

test('desistência da consulta: o que parece mas não é (contrato, preço, "imprevistos acontecem")', () => {
  for (const t of NAO_DESISTIU) assert.ok(!pareceDesistenciaDaConsulta(t), `não deveria pegar: ${t}`);
  assert.equal(pareceDesistenciaDaConsulta(null), false);
  assert.equal(pareceDesistenciaDaConsulta(undefined), false);
});

test('"remarcar" e "outro dia" sozinhos não são desistência: quem quer horário novo a Sofia já atende', () => {
  assert.equal(pareceDesistenciaDaConsulta('Preciso remarcar'), false);
  assert.equal(pareceDesistenciaDaConsulta('Pode ser outro dia?'), false);
});

const campo = (nome: string, valor: unknown) => ({ field_id: 1, field_name: nome, values: [{ value: valor }] });
const AGORA = Date.parse('2026-10-22T17:03:00Z') / 1000;

test('a data da consulta no cartão é lida pelo NOME do campo; passada (há mais de 3 h) não conta', () => {
  assert.equal(consultaFuturaDoCartao({ custom_fields_values: [campo('◷ Data da Consulta', 1792774800)] }, AGORA), 1792774800);
  assert.equal(consultaFuturaDoCartao({ custom_fields_values: [campo('◷ Data da Consulta', AGORA - 2 * 3600)] }, AGORA), AGORA - 2 * 3600, 'duas horas atrás ainda é "hoje"');
  assert.equal(consultaFuturaDoCartao({ custom_fields_values: [campo('◷ Data da Consulta', AGORA - 5 * 3600)] }, AGORA), null);
  assert.equal(consultaFuturaDoCartao({ custom_fields_values: [campo('◷ Próxima sessão', 1792774800)] }, AGORA), null, 'sessão não é consulta');
  assert.equal(consultaFuturaDoCartao({ custom_fields_values: [campo('◷ Data da Consulta', '')] }, AGORA), null);
  assert.equal(consultaFuturaDoCartao(null, AGORA), null);
});

test('a tarefa diz o que a equipe faz e por que o lembrete do Kommo continua saindo', () => {
  const t = textoTarefaDesistenciaSemIA({ slug: 'doutor-hernia-araguaina', nome: 'Liliane', quando: '23/10 às 14:00', mensagem: 'Cancelei.' });
  assert.match(t, /^ALERTA · doutor-hernia-araguaina · \[Contato: Liliane\]/);
  assert.match(t, /"Cancelei\."/);
  assert.match(t, /23\/10 às 14:00/);
  assert.match(t, /Desmarcado/);
  assert.match(t, /lembretes automáticos do Kommo continuam saindo/);
});

// ── a ação: IA pausada + "Cancelei." ────────────────────────────────────────────────────────────

function montar(opts: { lead?: object | null; avisado?: boolean; criaFalha?: boolean; lancaNoLead?: boolean } = {}) {
  const tarefas: Array<{ leadId: number; text: string; completeAt: number }> = [];
  const marcas: string[] = [];
  const deps: DepsDaDesistencia = {
    agora: () => new Date(AGORA * 1000),
    avisoRecente: async () => !!opts.avisado,
    marcarAviso: async (_u, _l, chave) => {
      marcas.push(chave);
    },
  };
  const kommo: KommoDaDesistencia = {
    getLead: async () => {
      if (opts.lancaNoLead) throw new Error('Kommo fora');
      return ('lead' in opts ? opts.lead : { id: 28861610, name: 'Francisco 20/10/26', custom_fields_values: [campo('◷ Data da Consulta', 1792774800)] }) as never;
    },
    createTask: async (a: { leadId: number; text: string; completeAt: number }) => {
      if (opts.criaFalha) return null;
      tarefas.push(a);
      return { id: 1 };
    },
  };
  const unit = { id: 'u1', slug: 'doutor-hernia-araguaina', spineTimezone: 'America/Araguaina', businessHoursTimezone: 'America/Araguaina' };
  return { deps, kommo, unit, tarefas, marcas };
}

test('Araguaína #28861610: "Cancelei." com a IA pausada e consulta no cartão → tarefa para a equipe, marcada depois', async () => {
  const m = montar();
  const r = await abrirTarefaDaDesistencia({ unit: m.unit, leadId: 28861610, texto: 'Cancelei.', nome: 'Liliane', motivo: 'ia_calada', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'tarefa_aberta');
  assert.equal(m.tarefas.length, 1);
  assert.match(m.tarefas[0].text, /Francisco/);
  assert.doesNotMatch(m.tarefas[0].text, /Liliane/, 'o nome é o do paciente (título do cartão), não o da esposa que escreveu');
  assert.match(m.tarefas[0].text, /23\/10 às 14:00/);
  assert.equal(m.marcas.length, 1);
  assert.equal(m.marcas[0], 'desistencia_tarefa:ia_calada');
});

test('mensagem repetida em 24 h: não abre outra tarefa', async () => {
  const m = montar({ avisado: true });
  assert.equal(await abrirTarefaDaDesistencia({ unit: m.unit, leadId: 1, texto: 'Cancelei.', motivo: 'ia_calada', kommo: () => m.kommo }, m.deps), 'ja_avisada');
  assert.equal(m.tarefas.length, 0);
});

test('sem consulta por vir no cartão, "cancelei" não vira tarefa (e "cancelei o plano" nem é lido como desistência)', async () => {
  const m = montar({ lead: { id: 1, name: 'Maria', custom_fields_values: [] } });
  assert.equal(await abrirTarefaDaDesistencia({ unit: m.unit, leadId: 1, texto: 'Cancelei.', motivo: 'ia_calada', kommo: () => m.kommo }, m.deps), 'sem_consulta');
  assert.equal(m.tarefas.length, 0);
});

test('mensagem que não é desistência: nem lê o cartão', async () => {
  const m = montar({ lancaNoLead: true });
  assert.equal(await abrirTarefaDaDesistencia({ unit: m.unit, leadId: 1, texto: 'Qual o valor?', motivo: 'ia_calada', kommo: () => m.kommo }, m.deps), 'nao_e');
});

test('o Kommo falhou: não lança e NÃO marca (a próxima mensagem tenta de novo)', async () => {
  const falhou = montar({ criaFalha: true });
  assert.equal(await abrirTarefaDaDesistencia({ unit: falhou.unit, leadId: 1, texto: 'Cancelei.', motivo: 'ia_calada', kommo: () => falhou.kommo }, falhou.deps), 'falhou');
  assert.equal(falhou.marcas.length, 0);
  const lancou = montar({ lancaNoLead: true });
  assert.equal(await abrirTarefaDaDesistencia({ unit: lancou.unit, leadId: 1, texto: 'Cancelei.', motivo: 'ia_calada', kommo: () => lancou.kommo }, lancou.deps), 'falhou');
  assert.equal(lancou.marcas.length, 0);
});

test('"não respondeu à oferta de novo horário": a tarefa diz isso, e a marca é outra que a da Sofia calada', async () => {
  const m = montar();
  const r = await abrirTarefaDaDesistencia({ unit: m.unit, leadId: 1, texto: 'Cancelei.', motivo: 'sem_resposta', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'tarefa_aberta');
  assert.match(m.tarefas[0].text, /A Sofia ofereceu outro horário e ele não respondeu/);
  assert.equal(m.marcas[0], 'desistencia_tarefa:sem_resposta');
});

test('unidade sem credencial do Kommo: a fábrica lança e NADA derruba o webhook', async () => {
  const m = montar();
  const r = await abrirTarefaDaDesistencia(
    { unit: m.unit, leadId: 1, texto: 'Cancelei.', motivo: 'ia_calada', kommo: () => { throw new Error('Unit sem credenciais Kommo configuradas'); } },
    m.deps,
  );
  assert.equal(r, 'falhou');
});

test('duas mensagens em segundos (ou webhook reenviado): uma tarefa só, mesmo antes de a marca gravar', async () => {
  const m = montar();
  const [a, b] = await Promise.all([
    abrirTarefaDaDesistencia({ unit: m.unit, leadId: 7, texto: 'Cancelei.', motivo: 'ia_calada', kommo: () => m.kommo }, m.deps),
    abrirTarefaDaDesistencia({ unit: m.unit, leadId: 7, texto: 'pode desmarcar', motivo: 'ia_calada', kommo: () => m.kommo }, m.deps),
  ]);
  assert.deepEqual([a, b].sort(), ['ja_avisada', 'tarefa_aberta']);
  assert.equal(m.tarefas.length, 1);
});

test('cartão com dois campos "Data da Consulta" (o velho vazio primeiro) ou a data em texto ISO: acha a data boa', () => {
  assert.equal(
    consultaFuturaDoCartao({ custom_fields_values: [campo('◷ Data da Consulta', ''), campo('◷ Data da Consulta', 1792774800)] }, AGORA),
    1792774800,
  );
  assert.equal(consultaFuturaDoCartao({ custom_fields_values: [campo('◷ Data da Consulta', '2026-10-23T14:00:00-03:00')] }, AGORA), 1792774800);
});
