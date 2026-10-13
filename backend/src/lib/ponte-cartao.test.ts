import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  barraDoFunil,
  caixinhaDaSdr,
  caixinhaMarcada,
  casarCartao,
  dddBrasileiro,
  estadoDaSofia,
  funilComercial,
  nomeCasa,
  ordenarCartoes,
  telefoneConfere,
  telefoneDaPonte,
  type PassosDoCasamento,
} from './ponte-cartao.js';

describe('telefoneDaPonte', () => {
  it('aceita só número de verdade, em dígitos', () => {
    assert.equal(telefoneDaPonte('5563991021043'), '5563991021043');
    assert.equal(telefoneDaPonte('+55 (63) 99102-1043'), '5563991021043');
    assert.equal(telefoneDaPonte('6391021043'), '6391021043');
  });

  it('o JID @lid NÃO vira telefone — nem qualquer coisa com @', () => {
    assert.equal(telefoneDaPonte('204567890123456@lid'), null);
    assert.equal(telefoneDaPonte('5563991021043@c.us'), null);
    assert.equal(telefoneDaPonte('120363012345678901@g.us'), null);
  });

  it('lixo, curto demais ou longo demais fica de fora', () => {
    assert.equal(telefoneDaPonte('123456'), null);
    assert.equal(telefoneDaPonte('1234567890123456'), null);
    assert.equal(telefoneDaPonte('Maria Souza'), null);
    assert.equal(telefoneDaPonte(''), null);
    assert.equal(telefoneDaPonte(5563991021043), null);
    assert.equal(telefoneDaPonte(undefined), null);
  });
});

describe('telefoneConfere — o número completo, não só o final', () => {
  it('mesmo número com e sem 55 e com e sem o nono dígito', () => {
    assert.ok(telefoneConfere('5563991021043', '+55 63 99102-1043'));
    assert.ok(telefoneConfere('5563991021043', '(63) 9102-1043'));
    assert.ok(telefoneConfere('556391021043', '63991021043'));
  });

  it('mesmo final em OUTRO DDD é outra pessoa (a busca do Kommo devolveria os dois)', () => {
    assert.equal(telefoneConfere('5563991021043', '+55 11 99102-1043'), false);
    assert.equal(telefoneConfere('5599991021043', '5563991021043'), false);
  });

  it('final diferente não confere; contato sem DDD confere pelos 8 últimos', () => {
    assert.equal(telefoneConfere('5563991021043', '5563991021044'), false);
    assert.ok(telefoneConfere('5563991021043', '9102-1043'));
    assert.equal(telefoneConfere('5563991021043', null), false);
    assert.equal(telefoneConfere('1043', '1043'), false);
  });

  it('DDD só de número brasileiro', () => {
    assert.equal(dddBrasileiro('5563991021043'), '63');
    assert.equal(dddBrasileiro('6391021043'), '63');
    assert.equal(dddBrasileiro('91021043'), null);
    assert.equal(dddBrasileiro('14155552671'), '14'); // 11 dígitos sem 55: tratado como brasileiro (DDD 14)
  });
});

describe('nomeCasa', () => {
  it('todas as palavras do cabeçalho no nome do contato, sem acento e sem a data do título', () => {
    assert.ok(nomeCasa('Maria Silva', 'Maria da Silva Santos'));
    assert.ok(nomeCasa('JOSÉ', 'Jose Carlos 03/10/2026'));
    assert.equal(nomeCasa('Maria Silva', 'Maria Souza'), false);
    assert.equal(nomeCasa('Jo', 'Jo Soares'), false); // nada com 3+ letras para buscar
    assert.equal(nomeCasa('', 'Maria'), false);
    assert.equal(nomeCasa('Maria', null), false);
  });
});

describe('ordenarCartoes', () => {
  it('abertos antes dos fechados (GANHO/PERDIDO), e o mais mexido primeiro', () => {
    const r = ordenarCartoes([
      { id: 1, status_id: 143, updated_at: 900 },
      { id: 2, status_id: 10, updated_at: 100 },
      { id: 3, status_id: 20, updated_at: 500 },
      { id: 4, status_id: 142, updated_at: 999 },
    ]);
    assert.deepEqual(r.map((l) => l.id), [3, 2, 4, 1]);
  });
});

describe('casarCartao — os 4 passos, nesta ordem, parando no primeiro que achar', () => {
  type Contatos = Array<{ nome: string | null; leadIds: number[] }>;
  function passos(r: { tel?: Contatos | Error; imp?: number | null | Error; nome?: number[][] | Error }) {
    const chamados: string[] = [];
    const devolve = <T>(nome: string, v: T | Error | undefined, vazio: T): Promise<T> => {
      chamados.push(nome);
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v === undefined ? vazio : v);
    };
    const p: PassosDoCasamento = {
      porTelefone: () => devolve<Contatos>('telefone', r.tel, []),
      porImpressao: () => devolve<number | null>('impressao', r.imp, null),
      porNome: () => devolve('nome', r.nome, []),
    };
    return { p, chamados };
  }
  const entrada = { telefone: '5563991021043', impressoes: ['a'.repeat(64)], nome: 'Maria Souza', manual: false };

  it('1. telefone achou: nem olha impressão nem nome', async () => {
    const { p, chamados } = passos({ tel: [{ nome: 'Maria Souza', leadIds: [10, 11, 10] }], imp: 20, nome: [[30]] });
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'achado', como: 'telefone', leadIds: [10, 11], incompleto: false });
    assert.deepEqual(chamados, ['telefone']);
  });

  it('1. contato duplicado no Kommo (mesmo nome, ou um sem nome): é a mesma pessoa, junta os cartões', async () => {
    const { p } = passos({ tel: [{ nome: 'MARIA SOUZA 03/10/2026', leadIds: [10] }, { nome: 'Maria Souza', leadIds: [11] }, { nome: null, leadIds: [12] }] });
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'achado', como: 'telefone', leadIds: [10, 11, 12], incompleto: false });
  });

  it('1. o mesmo número com contatos de NOMES diferentes (família dividindo o WhatsApp): a atendente escolhe', async () => {
    const { p, chamados } = passos({ tel: [{ nome: 'Maria Souza', leadIds: [10] }, { nome: 'João Souza', leadIds: [20, 21] }], imp: 30 });
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'candidatos', como: 'telefone', grupos: [[10], [20, 21]], incompleto: false });
    assert.deepEqual(chamados, ['telefone']);
  });

  it('1. contato com o telefone mas sem cartão nenhum não conta como achado', async () => {
    const { p, chamados } = passos({ tel: [{ nome: 'Maria', leadIds: [] }], imp: 20 });
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'achado', como: 'impressao', leadIds: [20], incompleto: false });
    assert.deepEqual(chamados, ['telefone', 'impressao']);
  });

  it('2. telefone não achou: vale a impressão, e o nome nem é perguntado', async () => {
    const { p, chamados } = passos({ tel: [], imp: 20, nome: [[30]] });
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'achado', como: 'impressao', leadIds: [20], incompleto: false });
    assert.deepEqual(chamados, ['telefone', 'impressao']);
  });

  it('3. só o nome achou, e um contato só: é ele (marcado "nome")', async () => {
    const { p, chamados } = passos({ nome: [[30, 31]] });
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'achado', como: 'nome', leadIds: [30, 31], incompleto: false });
    assert.deepEqual(chamados, ['telefone', 'impressao', 'nome']);
  });

  it('3. nome com MAIS DE UM contato: devolve os candidatos, não escolhe sozinho', async () => {
    const { p } = passos({ nome: [[30], [40, 41], []] });
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'candidatos', como: 'nome', grupos: [[30], [40, 41]], incompleto: false });
  });

  it('4. nada achou: diz quais passos tentou', async () => {
    const { p } = passos({});
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'nada', incompleto: false, passos: ['telefone', 'impressao', 'nome'] });
  });

  it('passo que FALHOU (Kommo fora) não é "não existe": segue para o próximo e marca incompleto', async () => {
    const { p, chamados } = passos({ tel: new Error('429'), imp: 20 });
    assert.deepEqual(await casarCartao(entrada, p), { tipo: 'achado', como: 'impressao', leadIds: [20], incompleto: true });
    assert.deepEqual(chamados, ['telefone', 'impressao']);
    const tudoFora = passos({ tel: new Error('x'), imp: new Error('y'), nome: new Error('z') });
    assert.deepEqual(await casarCartao(entrada, tudoFora.p), { tipo: 'nada', incompleto: true, passos: ['telefone', 'impressao', 'nome'] });
  });

  it('sem telefone (conversa @lid) e sem impressão: pula direto para o nome', async () => {
    const { p, chamados } = passos({ tel: [{ nome: 'Maria', leadIds: [10] }], nome: [[30]] });
    const r = await casarCartao({ telefone: null, impressoes: [], nome: 'Maria', manual: false }, p);
    assert.equal(r.tipo, 'achado');
    assert.deepEqual(chamados, ['nome']);
  });

  it('busca manual: só o nome, e o "como" vira manual', async () => {
    const { p, chamados } = passos({ tel: [{ nome: 'Maria', leadIds: [10] }], imp: 20, nome: [[30], [40]] });
    const r = await casarCartao({ ...entrada, manual: true }, p);
    assert.deepEqual(r, { tipo: 'candidatos', como: 'manual', grupos: [[30], [40]], incompleto: false });
    assert.deepEqual(chamados, ['nome']);
  });
});

describe('estadoDaSofia', () => {
  const agora = new Date('2026-10-13T13:00:00Z');
  const semPausa = { pausaDesde: null, pausaAte: null };
  it('na ordem do webhook: pausa da unidade, fora do horário, caixinha, pausa com data', () => {
    const unidade = { pausaDesde: null, pausaAte: new Date('2026-10-13T21:00:00Z') };
    assert.deepEqual(estadoDaSofia({ unidade, foraDoHorario: true, caixinha: true, janelaAte: null }, agora), { pausada: true, por: 'unidade', ate: '2026-10-13T21:00:00.000Z' });
    assert.deepEqual(estadoDaSofia({ unidade: semPausa, foraDoHorario: true, caixinha: true, janelaAte: null }, agora), { pausada: true, por: 'horario', ate: null });
    assert.deepEqual(estadoDaSofia({ unidade: semPausa, foraDoHorario: false, caixinha: true, janelaAte: null }, agora), { pausada: true, por: 'caixinha', ate: null });
    const ate = new Date('2026-10-15T12:00:00Z');
    assert.deepEqual(estadoDaSofia({ unidade: semPausa, foraDoHorario: false, caixinha: false, janelaAte: ate }, agora), { pausada: true, por: 'janela', ate: ate.toISOString() });
  });
  it('pausa vencida ou agendada para depois não conta', () => {
    assert.equal(estadoDaSofia({ unidade: semPausa, foraDoHorario: false, caixinha: false, janelaAte: new Date('2026-10-13T12:00:00Z') }, agora).pausada, false);
    const agendada = { pausaDesde: new Date('2026-10-14T11:00:00Z'), pausaAte: new Date('2026-10-14T21:00:00Z') };
    assert.deepEqual(estadoDaSofia({ unidade: agendada, foraDoHorario: false, caixinha: false, janelaAte: null }, agora), { pausada: false, por: null, ate: null });
  });
  it('caixinha "Pausar IA" em todos os formatos que o Kommo devolve', () => {
    for (const v of [true, 1, '1', 'true']) assert.ok(caixinhaMarcada(v), String(v));
    for (const v of [false, 0, '0', '', null, undefined, 'false']) assert.equal(caixinhaMarcada(v), false, String(v));
  });
  it('fase 2: a caixinha que a pausa com data marcou não esconde a data (o painel mostra "até …")', () => {
    const ate = new Date('2026-10-14T11:00:00Z');
    const nossa = { emPausa: true, campoMarcado: true };
    assert.equal(caixinhaDaSdr(true, nossa), false);
    assert.deepEqual(
      estadoDaSofia({ unidade: semPausa, foraDoHorario: false, caixinha: caixinhaDaSdr(true, nossa), janelaAte: ate }, agora),
      { pausada: true, por: 'janela', ate: ate.toISOString() },
    );
    // a SDR tinha marcado à mão antes: a caixinha é dela e continua valendo (sem data)
    assert.equal(caixinhaDaSdr(true, { emPausa: true, campoMarcado: false }), true);
    // pausa já vencida (o worker ainda não limpou): a caixinha volta a contar
    assert.equal(caixinhaDaSdr(true, { emPausa: false, campoMarcado: true }), true);
    assert.equal(caixinhaDaSdr(true, null), true);
    assert.equal(caixinhaDaSdr(false, nossa), false);
  });
});

describe('barrinha do funil COMERCIAL', () => {
  const comercial = {
    id: 13795975,
    name: 'COMERCIAL',
    is_main: true,
    statuses: [
      { id: 143, name: 'PERDIDO', sort: 11000, type: 0 },
      { id: 106446875, name: 'Etapa de leads de entrada', sort: 10, type: 1 },
      { id: 106809907, name: 'EM QUALIFICAÇÃO', sort: 20, type: 0 },
      { id: 106809915, name: 'AGENDADO', sort: 50, type: 0 },
      { id: 142, name: 'GANHO / CONCLUIDO', sort: 10000, type: 0 },
    ],
  };
  const tratamento = { id: 14304315, name: 'TRATAMENTO', is_main: false, statuses: [] };

  it('etapas na ordem, sem a caixa de entrada, com a atual marcada', () => {
    const b = barraDoFunil(comercial, { pipeline_id: 13795975, status_id: 106809915 });
    assert.deepEqual(b.map((e) => e.nome), ['EM QUALIFICAÇÃO', 'AGENDADO', 'GANHO / CONCLUIDO', 'PERDIDO']);
    assert.deepEqual(b.filter((e) => e.atual).map((e) => e.nome), ['AGENDADO']);
  });

  it('cartão parado na caixa de entrada: ela aparece, marcada', () => {
    const b = barraDoFunil(comercial, { pipeline_id: 13795975, status_id: 106446875 });
    assert.equal(b[0].nome, 'Etapa de leads de entrada');
    assert.ok(b[0].atual);
  });

  it('PERDIDO de OUTRO funil (143 existe em todos) não acende a barrinha do COMERCIAL', () => {
    const b = barraDoFunil(comercial, { pipeline_id: 14304315, status_id: 143 });
    assert.equal(b.some((e) => e.atual), false);
  });

  it('acha o COMERCIAL pelo nome; sem ele, o principal; arquivado não conta', () => {
    assert.equal(funilComercial([tratamento, comercial])?.id, 13795975);
    assert.equal(funilComercial([{ ...tratamento, is_main: true }, { ...comercial, name: 'Vendas', is_main: false }])?.id, 14304315);
    assert.equal(funilComercial([{ ...comercial, is_archive: true }]), null);
  });
});
