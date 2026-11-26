import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESPERA_ENTRE_ENVIOS_MIN,
  ID_DA_AUTOMACAO,
  MARGEM_DO_BANCO_MIN,
  MAX_ENVIOS,
  cicloDaUnidade,
  conferirAgendados,
  contagens,
  ehAvaliacao,
  estadoDaLista,
  leituraDesde,
  pixDesde,
  minutoDeInicio,
  textoDaLista,
  type Agendado,
  type DepsDoCiclo,
  type LeituraDoBanco,
  type MarcaLida,
  type UnidadeDaLista,
  type Veredito,
} from './agendados-sem-pix.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';
import type { PixRecebido } from './pix-casamento.js';

// nomes e valores INVENTADOS
const HOJE = '2026-11-26';
const VALORES = [5000, 20000, 25000, 35000];
/** o banco foi lido às 11:59 (hora de São Paulo = 14:59Z) */
const BANCO_LIDO_EM = Date.parse('2026-11-26T14:59:00.000Z');
/** marcado ontem à tarde (bem antes da leitura do banco) */
const ONTEM_TARDE = Date.parse('2026-11-25T18:00:00.000Z');
const ag = (nome: string | null, o: Partial<Agendado> = {}): Agendado => ({ nome, dia: '2026-11-27', hora: '08:30', agendadoEm: '2026-11-25', alteradoEmMs: ONTEM_TARDE, marcacaoIncerta: false, ...o });
const px = (id: string, nome: string, reais: number, o: Partial<PixRecebido> = {}): PixRecebido => ({ id, dia: '2026-11-25', centavos: Math.round(reais * 100), nomes: [nome], empresa: false, ...o });
const conf = (agendados: Agendado[], pix: PixRecebido[], o: { confiavel?: boolean; valores?: number[]; lidoEm?: number | null; podePagarNoDia?: boolean; conhecidos?: Array<string | null> } = {}) =>
  conferirAgendados(agendados, pix, {
    valores: o.valores ?? VALORES,
    hoje: HOJE,
    bancoConfiavel: o.confiavel ?? true,
    bancoLidoEm: o.lidoEm === undefined ? BANCO_LIDO_EM : o.lidoEm,
    podePagarNoDia: o.podePagarNoDia ?? false,
    ...(o.conhecidos ? { conhecidos: o.conhecidos } : {}),
  });

// ------------------------------------------------------------------------------------------------------------ a decisão

test('pagou: nome (primeiro + último) igual + valor da unidade + data; o Pix de até 7 dias antes da marcação vale', () => {
  const [a, b] = conf([ag('Maria da Conceição Silva'), ag('João Souza Neto', { hora: '09:00' })], [px('p1', 'MARIA CONCEICAO SILVA', 250), px('p2', 'JOAO SOUZA NETO', 50, { dia: '2026-11-20' })]);
  assert.equal(a!.resultado, 'pagou');
  assert.equal(b!.resultado, 'pagou', 'Pix de 5 dias antes da marcação ainda é dele');
});

test('o número do documento do pagador não entra no casamento: o Pix só tem nome, valor, data e se é de empresa', () => {
  const pix: PixRecebido = px('p1', 'FULANO PAGADOR DIFERENTE', 250);
  assert.deepEqual(Object.keys(pix).sort(), ['centavos', 'dia', 'empresa', 'id', 'nomes']);
  assert.notEqual(conf([ag('Maria Silva')], [pix])[0]!.resultado, 'pagou');
});

test('NÃO ACHEI PIX: nada no banco para o nome, banco confiável, marcado ANTES da leitura, sem Pix solto e unidade de taxa obrigatória', () => {
  const [v] = conf([ag('Maria Silva')], [px('p1', 'OUTRA PESSOA TOTAL', 80), px('p2', 'FULANO QUALQUER', 250, { dia: '2026-11-01' })]);
  assert.equal(v!.resultado, 'sem_pix');
});

test('REMARCADO/CONFIRMADO depois do pagamento: o extrato é lido desde 30 dias antes da CONSULTA, e o Pix velho de nome certo é «a conferir (outra data)», nunca «não achei»', () => {
  const remarcado = ag('Maria Silva', { agendadoEm: '2026-11-25', dia: '2026-11-30' }); // pagou no dia 10; alteração do registro no dia 25
  assert.equal(leituraDesde(remarcado), '2026-10-31', 'lê desde consulta − 30 dias (a janela de «pagou» seria 18/11)');
  assert.equal(pixDesde(remarcado), '2026-11-18');
  const [v] = conf([remarcado], [px('p1', 'MARIA SILVA', 250, { dia: '2026-11-10' })]);
  assert.deepEqual([v!.resultado, v!.motivo], ['conferir', 'data']);
  // Pix de nome certo e valor ERRADO e data fora (outro serviço): «valor», não «outra data»
  assert.equal(conf([remarcado], [px('p1', 'MARIA SILVA', 500, { dia: '2026-11-10' })])[0]!.motivo, 'valor');
});

test('a conferir, nunca «não achei»: valor diferente, data fora, nome parecido', () => {
  const r = conf(
    [ag('Maria Silva'), ag('Joana Lima', { hora: '09:00' }), ag('Pedro Alves Cardoso', { hora: '10:00' })],
    [px('p1', 'MARIA SILVA', 300), px('p2', 'JOANA LIMA', 250, { dia: '2026-10-01' }), px('p3', 'PEDRO ALVES CARD', 250)],
  );
  assert.deepEqual(r.map((v) => [v.resultado, v.motivo]), [['conferir', 'valor'], ['conferir', 'data'], ['conferir', 'nome-parecido']]);
});

test('o motivo do «a conferir» é o indício mais forte, qualquer que seja a ordem dos Pix', () => {
  const parecidoDepois = [px('p1', 'JOANA LIMA', 300), px('p2', 'JOANA LIM', 250)];
  assert.equal(conf([ag('Joana Lima')], parecidoDepois)[0]!.motivo, 'valor');
  assert.equal(conf([ag('Joana Lima')], [...parecidoDepois].reverse())[0]!.motivo, 'valor');
  const dataEParecido = [px('p1', 'JOANA LIMA', 250, { dia: '2026-10-01' }), px('p2', 'JOANA LIM', 250)];
  assert.equal(conf([ag('Joana Lima')], dataEParecido)[0]!.motivo, 'data');
  assert.equal(conf([ag('Joana Lima')], [...dataEParecido].reverse())[0]!.motivo, 'data');
});

test('a conferir: o mesmo Pix serve a dois agendados com o mesmo primeiro e último nome', () => {
  const r = conf([ag('Maria Santos Silva'), ag('Maria Souza Silva', { hora: '09:00' })], [px('p1', 'MARIA SILVA', 250)]);
  assert.deepEqual(r.map((v) => [v.resultado, v.motivo]), [['conferir', 'pix-compartilhado'], ['conferir', 'pix-compartilhado']]);
});

test('HOMÔNIMO: com outro paciente da agenda de mesmo primeiro e último nome, o Pix de nome igual NÃO é «pagou» — é «a conferir»; sem homônimo, é pagou', () => {
  const pix = [px('p1', 'MARIA SILVA', 250)];
  assert.equal(conf([ag('Maria Santos Silva')], pix)[0]!.resultado, 'pagou');
  const comHomonimo = conf([ag('Maria Santos Silva')], pix, { conhecidos: ['Maria Santos Silva', 'Maria Souza Silva'] });
  assert.deepEqual([comHomonimo[0]!.resultado, comHomonimo[0]!.motivo], ['conferir', 'homonimo']);
  // o MESMO nome inteiro (duas marcações da mesma pessoa) não é homônimo
  assert.equal(conf([ag('Maria Santos Silva')], pix, { conhecidos: ['MARIA SANTOS SILVA', 'Maria Santos Silva'] })[0]!.resultado, 'pagou');
});

test('o mesmo paciente com DUAS marcações e um só Pix é UMA pessoa: pagou (não «Pix compartilhado»)', () => {
  const r = conf([ag('Maria Santos Silva'), ag('Maria Santos Silva', { hora: '10:00', dia: '2026-11-28' })], [px('p1', 'MARIA SILVA', 250)]);
  assert.deepEqual(r.map((v) => v.resultado), ['pagou', 'pagou']);
});

test('a conferir: entrou Pix de valor de consulta em OUTRO nome (parente) — mas Pix de paciente CONHECIDO da agenda não conta como «de parente»', () => {
  const pix = [px('p1', 'ROBERTO PARENTE ALVES', 250), px('p2', 'TEREZA ANTIGA DIAS', 250)];
  const solto = conf([ag('Maria Silva')], pix);
  assert.deepEqual([solto[0]!.resultado, solto[0]!.motivo], ['conferir', 'pix-de-outro-nome']);
  assert.equal(conf([ag('Maria Silva')], pix, { conhecidos: ['Tereza Maria Antiga Dias'] })[0]!.motivo, 'pix-de-outro-nome');
  const todosConhecidos = conf([ag('Maria Silva')], pix, { conhecidos: ['Tereza Maria Antiga Dias', 'Roberto Carlos Parente Alves'] });
  assert.equal(todosConhecidos[0]!.resultado, 'sem_pix');
  assert.equal(conf([ag('Maria Silva')], [px('p3', 'TEREZA ANTIGA DIA', 250)], { conhecidos: ['Tereza Maria Antiga Dias'] })[0]!.motivo, 'pix-de-outro-nome', 'nome só parecido não tira o Pix da dúvida');
});

test('MARCADO DEPOIS DA LEITURA DO BANCO: banco lido 11:59, marcação 11:40, Pix 12:01 (que o banco ainda não viu) → NÃO é «não achei»', () => {
  const marcadoAs1140 = ag('Maria Silva', { agendadoEm: HOJE, alteradoEmMs: Date.parse('2026-11-26T14:40:00.000Z') });
  const [v] = conf([marcadoAs1140], []); // o Pix das 12:01 não está na leitura das 11:59
  assert.deepEqual([v!.resultado, v!.motivo], ['conferir', 'marcado-depois-do-banco']);
  // a margem: só quem foi marcado MARGEM_DO_BANCO_MIN minutos ou mais ANTES da leitura pode virar «não achei»
  const antesDaMargem = ag('Maria Silva', { agendadoEm: HOJE, alteradoEmMs: BANCO_LIDO_EM - (MARGEM_DO_BANCO_MIN + 1) * 60_000 });
  assert.equal(conf([antesDaMargem], [])[0]!.resultado, 'sem_pix');
  const dentroDaMargem = ag('Maria Silva', { agendadoEm: HOJE, alteradoEmMs: BANCO_LIDO_EM - (MARGEM_DO_BANCO_MIN - 1) * 60_000 });
  assert.equal(conf([dentroDaMargem], [])[0]!.motivo, 'marcado-depois-do-banco');
  // sem saber quando o banco foi lido, ninguém vira «não achei»
  assert.equal(conf([ag('Maria Silva')], [], { lidoEm: null })[0]!.motivo, 'marcado-depois-do-banco');
  // e Pix que EXISTE continua valendo: marcado depois da leitura, mas o Pix já estava lá = pagou
  assert.equal(conf([marcadoAs1140], [px('p1', 'MARIA SILVA', 250, { dia: HOJE })])[0]!.resultado, 'pagou');
});

test('marcação CONFIRMADA (a alteração é a confirmação): nunca «não achei»; com Pix certo, pagou', () => {
  const confirmada = ag('Maria Silva', { marcacaoIncerta: true });
  assert.deepEqual([conf([confirmada], [])[0]!.resultado, conf([confirmada], [])[0]!.motivo], ['conferir', 'marcacao-confirmada']);
  assert.equal(conf([confirmada], [px('p1', 'MARIA SILVA', 250)])[0]!.resultado, 'pagou');
});

test('UNIDADE ONDE O PACIENTE PODE PAGAR NO DIA («R$ 350 no dia»): sem Pix achado vira «a conferir», nunca «não achei»; com Pix certo, pagou', () => {
  const [v] = conf([ag('Maria Silva')], [], { podePagarNoDia: true });
  assert.deepEqual([v!.resultado, v!.motivo], ['conferir', 'pode-pagar-no-dia']);
  assert.equal(conf([ag('Maria Silva')], [px('p1', 'MARIA SILVA', 250)], { podePagarNoDia: true })[0]!.resultado, 'pagou');
});

test('banco que não atualizou hoje / sem valores / agenda sem sobrenome: tudo «a conferir»', () => {
  assert.deepEqual(conf([ag('Maria Silva')], [], { confiavel: false }).map((v) => v.motivo), ['banco-desatualizado']);
  assert.deepEqual(conf([ag('Maria Silva')], [], { valores: [] }).map((v) => v.motivo), ['sem-valores']);
  assert.deepEqual(conf([ag('Maria')], [px('p1', 'MARIA SILVA', 250)]).map((v) => v.motivo), ['nome-incompleto']);
  assert.deepEqual(conf([ag(null)], []).map((v) => v.motivo), ['nome-incompleto']);
  assert.deepEqual(conf([ag('Maria Silva')], [px('p1', 'MARIA SILVA', 250)], { valores: [] }).map((v) => v.resultado), ['conferir']);
});

test('Pix de empresa (PJ) nunca é de paciente', () => {
  const [v] = conf([ag('Clinica Teste Ltda')], [px('p1', 'CLINICA TESTE LTDA', 250, { empresa: true })]);
  assert.equal(v!.resultado, 'sem_pix');
});

test('categoria: aceita as grafias da avaliação e da consulta; reavaliação, retorno e sessão não', () => {
  for (const c of ['AVALIAÇÃO', 'Avaliacao', 'Avaliação inicial', 'CONSULTA', 'Consulta de avaliação', 'Primeira consulta', '1º Consulta', '1ª consulta', 'Avaliação Fisioterapêutica']) assert.equal(ehAvaliacao(c), true, c);
  for (const c of ['REAVALIAÇÃO', 'RETORNO', 'Consulta de retorno', 'SESSÃO', 'Sessão de fisioterapia', 'TRATAMENTO', '', null, undefined]) assert.equal(ehAvaliacao(c as string), false, String(c));
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

test('texto: primeiro nome, hora e o que achei; NUNCA sobrenome, documento, valor nem saldo; vazio quando todos pagaram', () => {
  const vs = conf([ag('Maria da Conceição Silva'), ag('Joana Lima', { hora: '14:00', dia: '2026-11-30' })], [px('p1', 'JOANA LIMA', 300)]);
  const t = textoDaLista(vs, { bancoAte: '26/11 11:59' })!;
  assert.match(t, /Agendados sem Pix/);
  assert.match(t, /Não achei Pix/);
  assert.match(t, /\*Maria\* — sexta-feira, 27\/11 às 08:30/);
  assert.match(t, /\*Joana\* — segunda-feira, 30\/11 às 14:00 \(achei Pix no nome, mas de valor diferente\)/);
  assert.match(t, /banco lido até 26\/11 11:59/);
  for (const proibido of ['Silva', 'Conceição', 'Lima', 'R$', '300', 'saldo', 'CPF']) assert.equal(t.includes(proibido), false, proibido);
  assert.equal(textoDaLista(conf([ag('Maria Silva')], [px('p1', 'MARIA SILVA', 250)]), { bancoAte: null }), null);
  assert.equal(textoDaLista([], { bancoAte: null }), null);
});

test('texto: NUNCA passa do orçamento (a Evolution corta em 1500 sem avisar): lista grande encolhe e diz quantos faltam, e o rodapé fica', () => {
  const nomes = Array.from({ length: 20 }, (_, i) => ag(`Paciente${String.fromCharCode(97 + i)} Teste`, { hora: `${String(8 + (i % 9)).padStart(2, '0')}:00` }));
  const semPix = conf(nomes.slice(0, 12), []);
  const comMotivo = conf(nomes, [px('p1', 'ROBERTO PARENTE ALVES', 250)]).slice(0, 15).map((v, i) => ({ ...v, agendado: { ...v.agendado, nome: `Conferir${String.fromCharCode(97 + i)} Teste` } }));
  const t = textoDaLista([...semPix, ...comMotivo], { bancoAte: '26/11 11:59' })!;
  assert.ok(t.length <= 1400, `tem ${t.length} caracteres`);
  assert.match(t, /… e mais \d+/);
  assert.match(t, /Pix feito depois dessa hora ainda não aparece aqui\.$/, 'o rodapé não é cortado');
});

// ------------------------------------------------------------------------------------------------------------ o ciclo

const unidade = (o: Partial<UnidadeDaLista> = {}): UnidadeDaLista => ({ id: 'u1', slug: 'doutor-hernia-teste', fuso: 'America/Sao_Paulo', hoje: HOJE, minutoDoDia: 12 * 60 + 20, diaDeTrabalho: true, agendadosDesde: '2026-11-25', podePagarNoDia: false, valores: VALORES, ...o });
const bancoOk = (pix: PixRecebido[] = []): LeituraDoBanco => ({ pix, lidoAte: '26/11 11:59', lidoAteMs: BANCO_LIDO_EM, confiavel: true });
const INICIO = 12 * 60 + 15;

function harness(o: { agendados?: Agendado[] | null; conhecidos?: Array<string | null>; banco?: LeituraDoBanco | null; destino?: string | null; evolution?: boolean; envios?: Array<'ok' | 'recusado' | 'incerto'>; marcas?: Map<string, MarcaLida>; reivindicar?: 'novo' | 'repetido' | 'erro'; naClinica?: number[]; agora?: number } = {}) {
  const marcas = o.marcas ?? new Map<string, MarcaLida>();
  let agora = o.agora ?? Date.parse('2026-11-26T15:20:00.000Z');
  const envios = [...(o.envios ?? [])];
  const chamadas = { agenda: 0, banco: [] as boolean[], enviados: [] as Array<{ numero: string; texto: string }>, marcas: [] as Array<{ id: string; estado: string; payload: Record<string, unknown> }>, avisos: [] as string[], concluidos: [] as string[] };
  const deps: DepsDoCiclo = {
    async agendados() { chamadas.agenda++; const a = o.agendados === undefined ? [ag('Maria Silva')] : o.agendados; return a === null ? null : { agendados: a, conhecidos: o.conhecidos ?? [] }; },
    async pagamNaClinica() { return new Set(o.naClinica ?? []); },
    async banco(_u, _d, lerMesmo) { chamadas.banco.push(lerMesmo); return o.banco === undefined ? bancoOk() : o.banco; },
    destino: () => (o.destino === undefined ? '120363000000000000@g.us' : o.destino),
    evolution: () => (o.evolution === false ? null : { url: 'http://evo/send', header: 'apikey', valor: 'x' }),
    async enviar(a) { chamadas.enviados.push({ numero: a.numero, texto: a.texto }); return envios.shift() ?? 'ok'; },
    marca: {
      async ler(id) { return marcas.get(id) ?? null; },
      async reivindicar(id, a) {
        chamadas.marcas.push({ id, estado: a.estado, payload: a.payload });
        if (o.reivindicar) return o.reivindicar;
        const ja = marcas.get(id);
        if (ja && !(a.estado === 'enviando' && ja.estado === 'pendente')) return 'repetido';
        marcas.set(id, { estado: a.estado, payload: ja ? { ...ja.payload, ...a.payload } : a.payload });
        return 'novo';
      },
      async concluir(id, estado, patch = {}) { chamadas.concluidos.push(estado); const ja = marcas.get(id); marcas.set(id, { estado, payload: { ...(ja?.payload ?? {}), ...patch } }); },
    },
    agora: () => agora,
    avisarUmaVez: (_c, msg) => void chamadas.avisos.push(msg),
  };
  return { deps, chamadas, marcas, avancar: (min: number) => { agora += min * 60_000; } };
}
const ID_LIGADO = `${ID_DA_AUTOMACAO}:doutor-hernia-teste:${HOJE}:ligado`;

test('SECO (o padrão): decide, GRAVA o texto que mandaria na marca do dia e não manda nada; não precisa de destino', async () => {
  const h = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'seco', h.deps, INICIO), 'simulado');
  assert.equal(h.chamadas.enviados.length, 0);
  assert.equal(h.chamadas.marcas[0]!.id, `${ID_DA_AUTOMACAO}:doutor-hernia-teste:${HOJE}:seco`);
  assert.equal(h.chamadas.marcas[0]!.estado, 'simulado');
  assert.match(String(h.chamadas.marcas[0]!.payload.texto), /Não achei Pix/);
  const semGrupo = harness({ destino: null, evolution: false });
  assert.equal(await cicloDaUnidade(unidade(), 'seco', semGrupo.deps, INICIO), 'simulado');
});

test('LIGADO com destino: manda UMA vez no grupo, guarda o texto na marca, e a volta seguinte não repete nem relê agenda e banco', async () => {
  const h = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, INICIO), 'enviado');
  assert.deepEqual(h.chamadas.enviados.map((e) => e.numero), ['120363000000000000@g.us']);
  assert.equal(h.marcas.get(ID_LIGADO)!.estado, 'enviado');
  assert.equal(h.marcas.get(ID_LIGADO)!.payload.texto, h.chamadas.enviados[0]!.texto, 'o texto fica na marca');
  const antes = h.chamadas.agenda;
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, INICIO), 'repetido');
  assert.equal(h.chamadas.enviados.length, 1);
  assert.equal(h.chamadas.agenda, antes);
});

test('LIGADO sem destino NÃO manda, avisa no log e NÃO gasta agenda nem banco nem a marca; sem a Evolution também não', async () => {
  const h = harness({ destino: null });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, INICIO), 'sem_destino');
  assert.equal(h.chamadas.enviados.length + h.chamadas.agenda + h.chamadas.banco.length + h.chamadas.marcas.length, 0);
  assert.match(h.chamadas.avisos[0]!, /sem destino em AGENDADOS_SEM_PIX_DESTINOS/);
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', harness().deps, INICIO), 'enviado');
  const semEvo = harness({ evolution: false });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', semEvo.deps, INICIO), 'sem_config');
  assert.equal(semEvo.chamadas.enviados.length, 0);
});

test('DESLIGADO não faz nada; fora do horário, em dia sem agenda ou feriado, e depois da janela, também não toca em nada', async () => {
  const h = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'desligado', h.deps), 'desligado');
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: 8 * 60 }), 'ligado', h.deps, INICIO), 'fora_do_horario');
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: 20 * 60 }), 'ligado', h.deps, INICIO), 'fora_do_horario');
  assert.equal(await cicloDaUnidade(unidade({ diaDeTrabalho: false }), 'ligado', h.deps, INICIO), 'fora_do_horario');
  assert.equal(h.chamadas.agenda + h.chamadas.banco.length + h.chamadas.marcas.length + h.chamadas.enviados.length, 0);
});

test('seco e ligado têm marcas DIFERENTES: o que o seco anotou não impede o ligado do mesmo dia', async () => {
  const h = harness();
  assert.equal(await cicloDaUnidade(unidade(), 'seco', h.deps, INICIO), 'simulado');
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, INICIO), 'enviado');
});

test('sem agendado recente, ou todos pagaram: não manda nada (todos pagaram fecha o dia; sem agendado, não)', async () => {
  const sem = harness({ agendados: [] });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', sem.deps, INICIO), 'sem_agendados');
  assert.equal(sem.chamadas.banco.length + sem.chamadas.enviados.length + sem.chamadas.marcas.length, 0, 'sem agendado não lê o banco e NÃO fecha o dia: quem for marcado à tarde entra na varredura seguinte');
  const pagos = harness({ banco: bancoOk([px('p1', 'MARIA SILVA', 250)]) });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', pagos.deps, INICIO), 'tudo_pago');
  assert.equal(pagos.chamadas.enviados.length, 0);
});

test('quem a conversa da Sofia marcou como «vai pagar na clínica» sai da lista', async () => {
  const h = harness({ agendados: [ag('Maria Silva', { idSchedule: 11 }), ag('Joana Lima', { idSchedule: 12, hora: '09:00' })], naClinica: [11] });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, INICIO), 'enviado');
  assert.equal(h.chamadas.enviados[0]!.texto.includes('Maria'), false);
  assert.match(h.chamadas.enviados[0]!.texto, /Joana/);
  const todos = harness({ agendados: [ag('Maria Silva', { idSchedule: 11 })], naClinica: [11] });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', todos.deps, INICIO), 'sem_agendados');
});

test('unidade que deixa pagar no dia: a lista inteira sai como «a conferir», nunca «Não achei Pix»', async () => {
  const h = harness({ banco: bancoOk([]) });
  assert.equal(await cicloDaUnidade(unidade({ podePagarNoDia: true }), 'ligado', h.deps, INICIO), 'enviado');
  const t = h.chamadas.enviados[0]!.texto;
  assert.match(t, /A conferir/);
  assert.match(t, /pode ter escolhido pagar no dia/);
  assert.equal(t.includes('Não achei Pix'), false);
});

test('banco que não atualizou hoje: espera sem ler o extrato e sem marcar; depois de 4 h sai tudo «a conferir» com o aviso', async () => {
  const velho: LeituraDoBanco = { pix: [], lidoAte: '25/11 11:59', lidoAteMs: BANCO_LIDO_EM - 86_400_000, confiavel: false };
  const h = harness({ banco: velho });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, INICIO), 'aguardando_banco');
  assert.deepEqual(h.chamadas.banco, [false]);
  assert.equal(h.chamadas.marcas.length + h.chamadas.enviados.length, 0);
  const ultima = harness({ banco: velho });
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: 16 * 60 + 20 }), 'ligado', ultima.deps, INICIO), 'enviado');
  const t = ultima.chamadas.enviados[0]!.texto;
  assert.match(t, /o banco ainda não atualizou hoje/);
  assert.equal(t.includes('Não achei Pix'), false);
});

test('falhas de leitura: agenda ou banco que não leu → não manda e não marca', async () => {
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', harness({ agendados: null }).deps, INICIO), 'agenda_falhou');
  const semBanco = harness({ banco: null });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', semBanco.deps, INICIO), 'banco_falhou');
  assert.equal(semBanco.chamadas.enviados.length + semBanco.chamadas.marcas.length, 0);
  assert.match(semBanco.chamadas.avisos[0]!, /não consegui ler o banco/, 'a falha não é muda');
  const semAgenda = harness({ agendados: null });
  await cicloDaUnidade(unidade(), 'ligado', semAgenda.deps, INICIO);
  assert.match(semAgenda.chamadas.avisos[0]!, /não consegui ler a agenda da franquia/);
});

// ---------------------------------------------------------------- envio sem metralhadora

test('RECUSA CERTA (4xx): repete com intervalo, no máximo 3 ENVIOS no total, SEM reler agenda nem banco, e depois desiste', async () => {
  const h = harness({ envios: ['recusado', 'recusado', 'recusado', 'recusado'] });
  const u = (min: number) => unidade({ minutoDoDia: INICIO + min });
  assert.equal(await cicloDaUnidade(u(0), 'ligado', h.deps, INICIO), 'recusado'); // envio 1
  assert.equal(h.marcas.get(ID_LIGADO)!.estado, 'pendente');
  assert.equal(await cicloDaUnidade(u(5), 'ligado', h.deps, INICIO), 'aguardando_nova_tentativa', 'a volta de 5 em 5 min NÃO reenvia');
  h.avancar(ESPERA_ENTRE_ENVIOS_MIN);
  assert.equal(await cicloDaUnidade(u(20), 'ligado', h.deps, INICIO), 'recusado'); // envio 2
  h.avancar(ESPERA_ENTRE_ENVIOS_MIN);
  assert.equal(await cicloDaUnidade(u(40), 'ligado', h.deps, INICIO), 'recusado'); // envio 3
  h.avancar(ESPERA_ENTRE_ENVIOS_MIN);
  assert.equal(await cicloDaUnidade(u(60), 'ligado', h.deps, INICIO), 'desistiu');
  assert.equal(h.marcas.get(ID_LIGADO)!.estado, 'desistido');
  assert.equal(await cicloDaUnidade(u(80), 'ligado', h.deps, INICIO), 'repetido');
  assert.equal(h.chamadas.enviados.length, MAX_ENVIOS, 'no máximo 3 envios no dia');
  assert.equal(h.chamadas.enviados.every((e) => e.texto === h.chamadas.enviados[0]!.texto), true, 'reenvia o texto guardado');
  assert.equal(h.chamadas.agenda, 1, 'a agenda foi lida UMA vez');
  assert.equal(h.chamadas.banco.length, 1, 'o banco foi lido UMA vez');
});

test('a repetição que dá certo fecha o dia como «enviado»', async () => {
  const h = harness({ envios: ['recusado', 'ok'] });
  await cicloDaUnidade(unidade(), 'ligado', h.deps, INICIO);
  h.avancar(ESPERA_ENTRE_ENVIOS_MIN);
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: INICIO + 20 }), 'ligado', h.deps, INICIO), 'enviado');
  assert.equal(h.marcas.get(ID_LIGADO)!.estado, 'enviado');
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: INICIO + 40 }), 'ligado', h.deps, INICIO), 'repetido');
  assert.equal(h.chamadas.enviados.length, 2);
});

test('5xx ou sem resposta é INCERTO (pode ter saído): UM envio e nunca repete', async () => {
  const h = harness({ envios: ['incerto', 'ok'] });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', h.deps, INICIO), 'incerto');
  assert.equal(h.marcas.get(ID_LIGADO)!.estado, 'incerto');
  h.avancar(ESPERA_ENTRE_ENVIOS_MIN * 4);
  assert.equal(await cicloDaUnidade(unidade({ minutoDoDia: INICIO + 60 }), 'ligado', h.deps, INICIO), 'repetido');
  assert.equal(h.chamadas.enviados.length, 1);
});

test('marca «enviando» sem desfecho não repete e avisa no log; duas varreduras ao mesmo tempo: só a que ganha a marca manda', async () => {
  const preso = harness({ marcas: new Map([[ID_LIGADO, { estado: 'enviando', payload: {} }]]) });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', preso.deps, INICIO), 'repetido');
  assert.equal(preso.chamadas.enviados.length, 0);
  assert.match(preso.chamadas.avisos[0]!, /«enviando» sem desfecho/);
  const corrida = harness({ reivindicar: 'repetido' });
  assert.equal(await cicloDaUnidade(unidade(), 'ligado', corrida.deps, INICIO), 'repetido');
  assert.equal(corrida.chamadas.enviados.length, 0);
});

// ------------------------------------------------------------------------------------------------------------ catálogo e chave

test('catálogo: a automação está na tela, nasce em «só no papel», avisa a recepção e EXIGE o seco antes de ligar', () => {
  const a = automacaoPorId('agendados-sem-pix');
  assert.ok(a);
  assert.equal(a.chave, 'AGENDADOS_SEM_PIX_SLUGS');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'seco');
  assert.equal(a.risco, 'manda-mensagem');
  assert.equal(a.exigeSecoAntes, true);
  assert.deepEqual(verificarCatalogo(AUTOMACOES), []);
});

test('estado: sem linha na tela e sem variável é SECO; a variável liga; a linha da tela vale mais e desliga', () => {
  _esquecerOBancoParaTeste();
  assert.equal(estadoDaLista('doutor-hernia-acailandia', undefined), 'seco');
  assert.equal(estadoDaLista('doutor-hernia-acailandia', 'doutor-hernia-acailandia'), 'ligado');
  assert.equal(estadoDaLista('outra-unidade', 'doutor-hernia-acailandia'), 'seco');
  _semearParaTeste([{ slug: 'doutor-hernia-acailandia', automacao: ID_DA_AUTOMACAO, estado: 'desligado' }]);
  assert.equal(estadoDaLista('doutor-hernia-acailandia', 'doutor-hernia-acailandia'), 'desligado', 'a tela desliga');
  _esquecerOBancoParaTeste();
});

test('horário de início: «HH:mm» da variável; valor ruim volta ao padrão 12:15', () => {
  assert.equal(minutoDeInicio(undefined), 12 * 60 + 15);
  assert.equal(minutoDeInicio('13:30'), 13 * 60 + 30);
  assert.equal(minutoDeInicio('25:00'), 12 * 60 + 15);
  assert.equal(minutoDeInicio('meio-dia'), 12 * 60 + 15);
});
