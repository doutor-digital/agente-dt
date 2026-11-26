import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ID_DA_AUTOMACAO,
  cicloDaUnidade,
  conferirAgendados,
  contagens,
  estadoDaLista,
  minutoDeInicio,
  textoDaLista,
  type Agendado,
  type DepsDoCiclo,
  type LeituraDoBanco,
  type UnidadeDaLista,
  type Veredito,
} from './agendados-sem-pix.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';
import type { PixRecebido } from './pix-casamento.js';

// nomes e documentos INVENTADOS
const HOJE = '2026-11-26';
const VALORES = [5000, 20000, 25000, 35000];
const ag = (nome: string | null, o: Partial<Agendado> = {}): Agendado => ({ nome, dia: '2026-11-27', hora: '08:30', agendadoEm: '2026-11-25', ...o });
const px = (id: string, nome: string, reais: number, o: Partial<PixRecebido> = {}): PixRecebido => ({ id, dia: '2026-11-25', centavos: Math.round(reais * 100), nomes: [nome], cpf: null, empresa: false, ...o });
const conf = (agendados: Agendado[], pix: PixRecebido[], o: { confiavel?: boolean; valores?: number[] } = {}) =>
  conferirAgendados(agendados, pix, { valores: o.valores ?? VALORES, hoje: HOJE, bancoConfiavel: o.confiavel ?? true });

// ------------------------------------------------------------------------------------------------------------ a decisão

test('pagou: nome (primeiro + último) igual + valor da unidade + data; o Pix de data anterior ao agendamento (até 7 dias) vale', () => {
  const [a, b] = conf([ag('Maria da Conceição Silva'), ag('João Souza Neto', { hora: '09:00' })], [px('p1', 'MARIA CONCEICAO SILVA', 250), px('p2', 'JOAO SOUZA NETO', 50, { dia: '2026-11-20' })]);
  assert.equal(a!.resultado, 'pagou');
  assert.equal(b!.resultado, 'pagou', 'Pix de 5 dias antes do agendamento ainda é dele');
});

test('pagou: CPF igual vale mesmo com o nome diferente (quando a fonte do paciente tem CPF); valor abaixo do sinal não vale', () => {
  const [pagou, pouco] = conf(
    [ag('Maria Silva', { cpf: '11122233344' }), ag('Ana Costa', { cpf: '55566677788' })],
    [px('p1', 'FULANO PAGADOR DIFERENTE', 250, { cpf: '11122233344' }), px('p2', 'ANA COSTA', 10, { cpf: '55566677788' })],
  );
  assert.equal(pagou!.resultado, 'pagou');
  assert.notEqual(pouco!.resultado, 'pagou', 'R$ 10 não é o sinal');
});

test('sem Pix: nada no banco para o nome, banco confiável e nenhum Pix solto de valor de consulta', () => {
  const [v] = conf([ag('Maria Silva')], [px('p1', 'OUTRA PESSOA TOTAL', 80), px('p2', 'FULANO QUALQUER', 250, { dia: '2026-11-01' })]);
  assert.equal(v!.resultado, 'sem_pix');
});

test('a conferir, nunca «não achei»: valor diferente, data fora, nome parecido', () => {
  const r = conf(
    [ag('Maria Silva'), ag('Joana Lima', { hora: '09:00' }), ag('Pedro Alves Cardoso', { hora: '10:00' })],
    [px('p1', 'MARIA SILVA', 300), px('p2', 'JOANA LIMA', 250, { dia: '2026-10-01' }), px('p3', 'PEDRO ALVES CARD', 250)],
  );
  assert.deepEqual(r.map((v) => [v.resultado, v.motivo]), [['conferir', 'valor'], ['conferir', 'data'], ['conferir', 'nome-parecido']]);
});

test('a conferir: o mesmo Pix serve a dois agendados com o mesmo primeiro e último nome (homônimos)', () => {
  const r = conf([ag('Maria Santos Silva'), ag('Maria Souza Silva', { hora: '09:00' })], [px('p1', 'MARIA SILVA', 250)]);
  assert.deepEqual(r.map((v) => [v.resultado, v.motivo]), [['conferir', 'pix-compartilhado'], ['conferir', 'pix-compartilhado']]);
});

test('a conferir: entrou Pix de valor de consulta em OUTRO nome (parente pagando) — mas Pix que já é de outro agendado não conta como solto', () => {
  const solto = conf([ag('Maria Silva')], [px('p1', 'ROBERTO PARENTE ALVES', 250)]);
  assert.deepEqual([solto[0]!.resultado, solto[0]!.motivo], ['conferir', 'pix-de-outro-nome']);
  const dosOutros = conf([ag('Maria Silva'), ag('Ana Costa', { hora: '09:00' })], [px('p1', 'ANA COSTA', 250)]);
  assert.deepEqual(dosOutros.map((v) => v.resultado), ['sem_pix', 'pagou'], 'o Pix da Ana é da Ana: a Maria segue sem Pix');
});

test('Pix de valor de consulta que é de um paciente CONHECIDO da agenda (marcado antes, em tratamento) não é «Pix de parente»: quem está sem Pix segue «não achei»', () => {
  const pix = [px('p1', 'ROBERTO PARENTE ALVES', 250), px('p2', 'TEREZA ANTIGA DIAS', 250)];
  const semConhecidos = conf([ag('Maria Silva')], pix);
  assert.deepEqual([semConhecidos[0]!.resultado, semConhecidos[0]!.motivo], ['conferir', 'pix-de-outro-nome']);
  // o Pix da Tereza é de paciente já na agenda: sobra só o do parente desconhecido, e ele continua deixando a Maria «a conferir»
  const comUma = conferirAgendados([ag('Maria Silva')], pix, { valores: VALORES, hoje: HOJE, bancoConfiavel: true, conhecidos: ['Tereza Maria Antiga Dias'] });
  assert.equal(comUma[0]!.motivo, 'pix-de-outro-nome');
  // os dois Pix são de pacientes conhecidos: nenhum é «de parente», a Maria está sem Pix
  const comAs = conferirAgendados([ag('Maria Silva')], pix, { valores: VALORES, hoje: HOJE, bancoConfiavel: true, conhecidos: ['Tereza Maria Antiga Dias', 'Roberto Carlos Parente Alves'] });
  assert.deepEqual([comAs[0]!.resultado, comAs[0]!.motivo], ['sem_pix', undefined]);
  // nome só PARECIDO com um conhecido não tira o Pix da dúvida
  const parecido = conferirAgendados([ag('Maria Silva')], [px('p3', 'TEREZA ANTIGA DIA', 250)], { valores: VALORES, hoje: HOJE, bancoConfiavel: true, conhecidos: ['Tereza Maria Antiga Dias'] });
  assert.equal(parecido[0]!.motivo, 'pix-de-outro-nome');
});

test('banco que não atualizou hoje / sem valores conhecidos / agenda sem sobrenome: tudo «a conferir», nada vira «não achei» nem «pagou» por falta de dado', () => {
  assert.deepEqual(conf([ag('Maria Silva')], [], { confiavel: false }).map((v) => v.motivo), ['banco-desatualizado']);
  assert.deepEqual(conf([ag('Maria Silva')], [], { valores: [] }).map((v) => v.motivo), ['sem-valores']);
  assert.deepEqual(conf([ag('Maria')], [px('p1', 'MARIA SILVA', 250)]).map((v) => v.motivo), ['nome-incompleto']);
  assert.deepEqual(conf([ag(null)], []).map((v) => v.motivo), ['nome-incompleto']);
  // sem valores, nem o nome igual fecha como «pagou»
  assert.deepEqual(conf([ag('Maria Silva')], [px('p1', 'MARIA SILVA', 250)], { valores: [] }).map((v) => v.resultado), ['conferir']);
});

test('Pix de empresa (CNPJ) nunca é de paciente; Pix de data futura ao hoje não existe', () => {
  const [v] = conf([ag('Clinica Teste Ltda')], [px('p1', 'CLINICA TESTE LTDA', 250, { empresa: true })]);
  assert.equal(v!.resultado, 'sem_pix');
});

test('contagens e ordem: o texto sai em ordem de horário', () => {
  const vs: Veredito[] = [
    { agendado: ag('Zeca Tester', { hora: '10:00' }), resultado: 'sem_pix' },
    { agendado: ag('Ana Tester', { hora: '08:00' }), resultado: 'sem_pix' },
    { agendado: ag('Bia Tester'), resultado: 'pagou' },
  ];
  assert.deepEqual(contagens(vs), { agendados: 3, pagou: 1, semPix: 2, conferir: 0 });
  const t = textoDaLista(vs, { bancoAte: '26/11 11:59' })!;
  assert.ok(t.indexOf('Ana') < t.indexOf('Zeca'));
});

// ------------------------------------------------------------------------------------------------------------ o texto

test('texto: primeiro nome, hora e «não achei Pix»; NUNCA sobrenome, CPF, valor nem saldo; vazio quando todos pagaram', () => {
  const vs = conf(
    [ag('Maria da Conceição Silva', { cpf: '11122233344' }), ag('Joana Lima', { hora: '14:00', dia: '2026-11-30' })],
    [px('p1', 'JOANA LIMA', 300, { cpf: '99988877766' })],
  );
  const t = textoDaLista(vs, { bancoAte: '26/11 11:59' })!;
  assert.match(t, /Agendados sem Pix/);
  assert.match(t, /Não achei Pix/);
  assert.match(t, /\*Maria\* — sexta-feira, 27\/11 às 08:30/);
  assert.match(t, /\*Joana\* — segunda-feira, 30\/11 às 14:00 \(achei Pix no nome, mas de valor diferente\)/);
  assert.match(t, /banco lido até 26\/11 11:59/);
  for (const proibido of ['Silva', 'Conceição', 'Lima', '11122233344', '111.222', '99988877766', 'R$', '300', 'saldo', 'CPF']) assert.equal(t.includes(proibido), false, proibido);
  assert.equal(textoDaLista(conf([ag('Maria Silva')], [px('p1', 'MARIA SILVA', 250)]), { bancoAte: null }), null);
  assert.equal(textoDaLista([], { bancoAte: null }), null);
});

test('texto: corta em 15 por bloco e diz quantos faltam', () => {
  const muitos = Array.from({ length: 18 }, (_, i) => ag(`Paciente${String.fromCharCode(97 + i)} Teste`, { hora: `${String(8 + (i % 9)).padStart(2, '0')}:00` }));
  const t = textoDaLista(conf(muitos, []), { bancoAte: null })!;
  assert.equal(t.split('\n').filter((l) => l.startsWith('• ')).length, 15);
  assert.match(t, /… e mais 3/);
  assert.ok(t.length < 1500, 'cabe nos 1500 caracteres que a Evolution aceita');
});

// ------------------------------------------------------------------------------------------------------------ o ciclo (seco, ligado, destino, banco)

const unidade = (o: Partial<UnidadeDaLista> = {}): UnidadeDaLista => ({ id: 'u1', slug: 'doutor-hernia-teste', fuso: 'America/Sao_Paulo', hoje: HOJE, minutoDoDia: 12 * 60 + 20, diaDeTrabalho: true, valores: VALORES, ...o });
const bancoOk = (pix: PixRecebido[] = []): LeituraDoBanco => ({ pix, lidoAte: '26/11 11:59', confiavel: true });

function harness(o: { agendados?: Agendado[] | null; conhecidos?: Array<string | null>; banco?: LeituraDoBanco | null; destino?: string | null; evolution?: boolean; envio?: 'ok' | 'recusado' | 'incerto'; marcas?: Map<string, string>; reivindicar?: 'novo' | 'repetido' | 'erro' } = {}) {
  const marcas = o.marcas ?? new Map<string, string>();
  const chamadas = { agenda: 0, banco: [] as boolean[], enviados: [] as Array<{ numero: string; texto: string }>, marcas: [] as Array<{ id: string; estado: string; payload: Record<string, unknown> }>, avisos: [] as string[], concluidos: [] as string[] };
  const deps: DepsDoCiclo = {
    async agendados() { chamadas.agenda++; const a = o.agendados === undefined ? [ag('Maria Silva')] : o.agendados; return a === null ? null : { agendados: a, conhecidos: o.conhecidos ?? [] }; },
    async banco(_u, _d, lerMesmo) { chamadas.banco.push(lerMesmo); return o.banco === undefined ? bancoOk() : o.banco; },
    destino: () => (o.destino === undefined ? '120363000000000000@g.us' : o.destino),
    evolution: () => (o.evolution === false ? null : { url: 'http://evo/send', header: 'apikey', valor: 'x' }),
    async enviar(a) { chamadas.enviados.push({ numero: a.numero, texto: a.texto }); return o.envio ?? 'ok'; },
    marca: {
      async estado(id) { return marcas.get(id) ?? null; },
      async reivindicar(id, a) {
        chamadas.marcas.push({ id, estado: a.estado, payload: a.payload });
        if (o.reivindicar) return o.reivindicar;
        if (marcas.has(id) && !(a.estado === 'enviando' && marcas.get(id) === 'pendente')) return 'repetido';
        marcas.set(id, a.estado);
        return 'novo';
      },
      async concluir(id, estado) { chamadas.concluidos.push(estado); marcas.set(id, estado); },
    },
    avisarUmaVez: (_c, msg) => void chamadas.avisos.push(msg),
  };
  return { deps, chamadas, marcas };
}

test('SECO (o padrão): decide, GRAVA o texto que mandaria na marca do dia e não manda nada', async () => {
  const h = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'seco', h.deps, 12 * 60 + 15), 'simulado');
  assert.equal(h.chamadas.enviados.length, 0, 'seco nunca envia');
  assert.equal(h.chamadas.marcas.length, 1);
  assert.equal(h.chamadas.marcas[0]!.id, `${ID_DA_AUTOMACAO}:doutor-hernia-teste:${HOJE}:seco`);
  assert.equal(h.chamadas.marcas[0]!.estado, 'simulado');
  assert.match(String(h.chamadas.marcas[0]!.payload.texto), /Não achei Pix/);
  assert.equal(h.chamadas.marcas[0]!.payload.semPix, 1);
  // seco não precisa de destino: roda mesmo sem grupo configurado
  const semGrupo = harness({ destino: null, evolution: false });
  assert.equal(await cicloDaUnidade(unidade(), 'seco', semGrupo.deps, 12 * 60 + 15), 'simulado');
});

test('LIGADO com destino: manda UMA vez no grupo e a marca fica «enviado»; a volta seguinte não repete', async () => {
  const h = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, 12 * 60 + 15), 'enviado');
  assert.deepEqual(h.chamadas.enviados.map((e) => e.numero), ['120363000000000000@g.us']);
  assert.match(h.chamadas.enviados[0]!.texto, /\*Maria\*/);
  assert.equal(h.marcas.get(`${ID_DA_AUTOMACAO}:doutor-hernia-teste:${HOJE}:ligado`), 'enviado');
  const agendaAntes = h.chamadas.agenda;
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, 12 * 60 + 15), 'repetido');
  assert.equal(h.chamadas.enviados.length, 1);
  assert.equal(h.chamadas.agenda, agendaAntes, 'marca do dia: nem a agenda nem o banco são lidos de novo');
});

test('LIGADO sem destino NÃO manda, avisa no log e NÃO gasta agenda nem banco nem a marca (sai assim que o João configurar)', async () => {
  const h = harness({ destino: null });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, 12 * 60 + 15), 'sem_destino');
  assert.equal(h.chamadas.enviados.length, 0);
  assert.equal(h.chamadas.agenda + h.chamadas.banco.length + h.chamadas.marcas.length, 0);
  assert.match(h.chamadas.avisos[0]!, /sem destino em AGENDADOS_SEM_PIX_DESTINOS/);
  // configurou: a mesma varredura do mesmo dia manda
  const configurado = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', configurado.deps, 12 * 60 + 15), 'enviado');
  // sem a Evolution também não manda
  const semEvo = harness({ evolution: false });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', semEvo.deps, 12 * 60 + 15), 'sem_config');
  assert.equal(semEvo.chamadas.enviados.length, 0);
});

test('DESLIGADO não faz nada; fora do horário, em dia sem agenda ou feriado, e depois da janela, também não toca em nada', async () => {
  const h = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'desligado', h.deps), 'desligado');
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: 8 * 60 }), 'ligado', h.deps, 12 * 60 + 15), 'fora_do_horario', 'antes da sincronização do banco');
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: 20 * 60 }), 'ligado', h.deps, 12 * 60 + 15), 'fora_do_horario', 'depois da janela');
  assert.equal(await cicloDaUnidade(unidade({ diaDeTrabalho: false }), 'ligado', h.deps, 12 * 60 + 15), 'fora_do_horario');
  assert.equal(h.chamadas.agenda + h.chamadas.banco.length + h.chamadas.marcas.length + h.chamadas.enviados.length, 0);
});

test('seco e ligado têm marcas DIFERENTES: o que o seco anotou não impede o ligado do mesmo dia', async () => {
  const h = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'seco', h.deps, 12 * 60 + 15), 'simulado');
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, 12 * 60 + 15), 'enviado');
});

test('sem agendado recente: marca o dia (sem ler o banco) e não manda', async () => {
  const h = harness({ agendados: [] });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, 12 * 60 + 15), 'sem_agendados');
  assert.equal(h.chamadas.banco.length, 0, 'sem agendado não se lê o extrato');
  assert.equal(h.chamadas.enviados.length, 0);
});

test('todo mundo pagou: não manda mensagem nenhuma e marca o dia', async () => {
  const h = harness({ banco: bancoOk([px('p1', 'MARIA SILVA', 250)]) });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, 12 * 60 + 15), 'tudo_pago');
  assert.equal(h.chamadas.enviados.length, 0);
});

test('banco que não atualizou hoje: espera sem ler o extrato e sem marcar; depois de 4 h sai tudo «a conferir» com o aviso', async () => {
  const velho: LeituraDoBanco = { pix: [], lidoAte: '25/11 11:59', confiavel: false };
  const h = harness({ banco: velho });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, 12 * 60 + 15), 'aguardando_banco');
  assert.deepEqual(h.chamadas.banco, [false], 'pediu SEM ler o extrato desatualizado');
  assert.equal(h.chamadas.marcas.length, 0);
  assert.equal(h.chamadas.enviados.length, 0);
  const ultima = harness({ banco: velho });
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: 16 * 60 + 20 }), 'ligado', ultima.deps, 12 * 60 + 15), 'enviado');
  assert.deepEqual(ultima.chamadas.banco, [true]);
  const t = ultima.chamadas.enviados[0]!.texto;
  assert.match(t, /A conferir/);
  assert.match(t, /o banco ainda não atualizou hoje/);
  assert.equal(t.includes('Não achei Pix'), false, 'com banco velho nada vira «não achei»');
});

test('falhas: agenda ou banco que não leu → não manda, não marca; a Evolution recusou → marca «pendente» e a volta seguinte tenta de novo; sem resposta → «incerto» e nunca repete', async () => {
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', harness({ agendados: null }).deps, 12 * 60 + 15), 'agenda_falhou');
  const semBanco = harness({ banco: null });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', semBanco.deps, 12 * 60 + 15), 'banco_falhou');
  assert.equal(semBanco.chamadas.enviados.length + semBanco.chamadas.marcas.length, 0);

  const recusa = harness({ envio: 'recusado' });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', recusa.deps, 12 * 60 + 15), 'recusado');
  assert.deepEqual(recusa.chamadas.concluidos, ['pendente']);
  const novo = harness({ marcas: recusa.marcas });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', novo.deps, 12 * 60 + 15), 'enviado', 'a marca pendente deixa tentar de novo');

  const incerto = harness({ envio: 'incerto' });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', incerto.deps, 12 * 60 + 15), 'incerto');
  const depois = harness({ marcas: incerto.marcas });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', depois.deps, 12 * 60 + 15), 'repetido', 'pode ter saído: não manda em dobro');
  assert.equal(depois.chamadas.enviados.length, 0);
});

test('duas varreduras ao mesmo tempo: só a que ganha a marca manda', async () => {
  const h = harness({ reivindicar: 'repetido' });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, 12 * 60 + 15), 'repetido');
  assert.equal(h.chamadas.enviados.length, 0);
});

// ------------------------------------------------------------------------------------------------------------ catálogo e chave

test('catálogo: a automação está na tela, nasce em «só no papel», avisa recepção e NÃO exige seco antes (decisão do João: liga direto)', () => {
  const a = automacaoPorId('agendados-sem-pix');
  assert.ok(a);
  assert.equal(a.chave, 'AGENDADOS_SEM_PIX_SLUGS');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'seco');
  assert.equal(a.risco, 'manda-mensagem');
  assert.equal(a.exigeSecoAntes, undefined);
  assert.deepEqual(verificarCatalogo(AUTOMACOES), []);
});

test('estado: sem linha na tela e sem variável é SECO; a variável liga; a linha da tela vale mais e desliga', () => {
  _esquecerOBancoParaTeste();
  assert.equal(estadoDaLista('doutor-hernia-acailandia', undefined), 'seco');
  assert.equal(estadoDaLista('doutor-hernia-acailandia', 'doutor-hernia-acailandia'), 'ligado');
  assert.equal(estadoDaLista('outra-unidade', 'doutor-hernia-acailandia'), 'seco');
  _semearParaTeste([{ slug: 'doutor-hernia-acailandia', automacao: ID_DA_AUTOMACAO, estado: 'desligado' }]);
  assert.equal(estadoDaLista('doutor-hernia-acailandia', 'doutor-hernia-acailandia'), 'desligado', 'a tela desliga');
  _semearParaTeste([{ slug: 'doutor-hernia-acailandia', automacao: ID_DA_AUTOMACAO, estado: 'ligado' }]);
  assert.equal(estadoDaLista('doutor-hernia-acailandia', undefined), 'ligado', 'a tela liga direto, sem passar pelo seco');
  _esquecerOBancoParaTeste();
});

test('horário de início: «HH:mm» da variável; valor ruim volta ao padrão 12:15', () => {
  assert.equal(minutoDeInicio(undefined), 12 * 60 + 15);
  assert.equal(minutoDeInicio('13:30'), 13 * 60 + 30);
  assert.equal(minutoDeInicio('9:05'), 9 * 60 + 5);
  assert.equal(minutoDeInicio('25:00'), 12 * 60 + 15);
  assert.equal(minutoDeInicio('meio-dia'), 12 * 60 + 15);
});
