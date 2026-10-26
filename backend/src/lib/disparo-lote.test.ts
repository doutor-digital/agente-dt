import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREIOS_PADRAO, type Freios } from './disparo/freios.js';
import { rodarUnidade, rodadasSemAndar, motivoDaMeta, type DadosDeGravacao, type Destino, type Modo, type OndaNoLote, type Porto, type UnidadeNoLote } from './disparo/lote.js';
import type { ResultadoDoTemplate } from './whatsapp-meta.js';
import type { SituacaoNaFranquia } from './disparo/regras.js';

// Quarta 21/10/2026, 09h30 em São Paulo (dentro da janela).
const AGORA = new Date(Date.UTC(2026, 9, 21, 12, 30));
const MADRUGADA = new Date(Date.UTC(2026, 9, 21, 6, 0));
const sem_pausa: Freios = { ...FREIOS_PADRAO, pausaMs: 0 };
const UNIDADE: UnidadeNoLote = { id: 'u1', slug: 'doutor-hernia-canaa', nome: 'Doutor Hérnia Canaã', fuso: 'America/Sao_Paulo' };
const ONDA: OndaNoLote = { id: 'o1', campanhaId: 'c1', aprovadaEm: new Date(Date.UTC(2026, 9, 20, 15)), aprovadaModo: 'ligado', template: 'canaa_resgate', idioma: 'pt_BR', textoModelo: 'Oi {{1}}!', variaveis: ['primeiroNome'], cabecalho: null };

function destino(n: number): Destino {
  return { id: `d${n}`, ondaId: 'o1', campanhaId: 'c1', unitId: 'u1', telefone: `55639910210${String(n).padStart(2, '0')}`, chave: `6391021${String(n).padStart(3, '0')}`, nome: `Pessoa${n}`, nomeCompleto: `Pessoa${n} Silva`, kommoLeadId: 1000 + n };
}

/** Um Porto de mentira que registra TUDO que sai da casa. */
function montar(opcoes: { modo: Modo; quantos?: number; agora?: Date; franquia?: (d: Destino) => SituacaoNaFranquia; sairam?: number; naHora?: number; noDia?: number; teste?: string[] | null; envio?: (d: Destino) => ResultadoDoTemplate | Promise<ResultadoDoTemplate>; pediuSair?: (d: Destino) => boolean; reivindicar?: (d: Destino) => boolean; ultimos?: Array<'enviado' | 'falhou'>; ondaViva?: (chamada: number) => boolean }) {
  const estados = new Map<string, Omit<DadosDeGravacao, 'estado'> & { estado: string }>();
  const todos = Array.from({ length: opcoes.quantos ?? 3 }, (_, i) => destino(i + 1));
  todos.forEach((d) => estados.set(d.id, { estado: 'pendente' }));
  let consultasDeOnda = 0;
  // A fila do banco é por "última atualização" (quem foi adiado vai para o fim): a falsa imita isso.
  const toque = new Map<string, number>();
  let relogio = 0;
  const desdeDasFalhas: Date[] = [];
  const chamadas = { desdeDasFalhas, enviar: [] as string[], espelhar: [] as string[], pausas: [] as string[], causas: [] as Array<string | undefined>, devolvidas: [] as string[], concluidas: [] as string[], logs: [] as string[] };
  const porto: Porto = {
    agora: () => opcoes.agora ?? AGORA,
    modoDaUnidade: () => opcoes.modo,
    listaDeTeste: () => (opcoes.teste ? new Set(opcoes.teste) : null),
    contarNaJanela: async (_u, desde) => (AGORA.getTime() - desde.getTime() <= 3_600_000 ? (opcoes.naHora ?? 0) : (opcoes.noDia ?? 0)),
    pendentes: async (_o, modo, limite, so) =>
      todos
        .filter((d) => estados.get(d.id)!.estado === 'pendente' && (modo === 'ligado' || !estados.get(d.id)!.simuladoEm) && (!so || so.has(d.telefone)))
        .sort((a, b) => (toque.get(a.id) ?? 0) - (toque.get(b.id) ?? 0))
        .slice(0, limite),
    sobram: async (_o, modo, so) => todos.filter((d) => estados.get(d.id)!.estado === 'pendente' && (modo === 'ligado' || !estados.get(d.id)!.simuladoEm) && (!so || so.has(d.telefone))).length,
    quantosSairam: async () => opcoes.sairam ?? 0,
    ultimosResultados: async (_u, _n, desde) => {
      desdeDasFalhas.push(desde);
      return opcoes.ultimos ?? [];
    },
    ondaAprovada: async () => opcoes.ondaViva?.(++consultasDeOnda) ?? true,
    reivindicar: async (id) => {
      const d = todos.find((x) => x.id === id)!;
      if (opcoes.reivindicar && !opcoes.reivindicar(d)) return false;
      Object.assign(estados.get(id)!, { estado: 'enviando', enviadoEm: AGORA });
      return true;
    },
    gravar: async (id, dados) => void (Object.assign(estados.get(id)!, dados), toque.set(id, ++relogio)),
    pausarOndas: async (_u, _c, motivo, causa) => void (chamadas.pausas.push(motivo), chamadas.causas.push(causa)),
    pausarOnda: async (_id, motivo, causa) => void (chamadas.pausas.push(motivo), chamadas.causas.push(causa)),
    devolverParaAprovacao: async (id, motivo) => void chamadas.devolvidas.push(`${id}|${motivo}`),
    concluirOnda: async (id) => void chamadas.concluidas.push(id),
    pediuSair: async (d) => opcoes.pediuSair?.(d) ?? false,
    franquia: async (d) => opcoes.franquia?.(d) ?? 'livre',
    enviar: async (_o, d) => {
      chamadas.enviar.push(d.telefone);
      return opcoes.envio ? opcoes.envio(d) : { ok: true, wamid: `wamid.${d.id}`, detalhe: {}, incerto: false };
    },
    espelhar: async (d, texto) => void chamadas.espelhar.push(`${d.kommoLeadId}|${texto}`),
    dormir: async () => undefined,
    log: (_n, _d, msg) => void chamadas.logs.push(msg),
  };
  return { porto, estados, chamadas, todos };
}

// ── MODO SECO ───────────────────────────────────────────────────────────────────────────────────────────────

test('SECO: decide e grava quem RECEBERIA, mas não manda nada e não escreve no Kommo', async () => {
  const t = montar({ modo: 'seco', quantos: 3 });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.receberia, 3);
  assert.equal(r.mandou, 0);
  assert.deepEqual(t.chamadas.enviar, [], 'enviarTemplate NUNCA é chamado em seco');
  assert.deepEqual(t.chamadas.espelhar, [], 'nenhuma nota no Kommo em seco');
  assert.deepEqual(t.chamadas.concluidas, [], 'seco não conclui a onda: ela continua esperando alguém ligar a unidade');
  for (const e of t.estados.values()) {
    assert.equal(e.estado, 'pendente', 'continua pendente para um futuro envio real');
    assert.ok(e.simuladoEm, 'mas o "receberia" ficou gravado');
    assert.equal(e.enviadoEm, undefined);
    assert.equal(e.wamid, undefined);
  }
  assert.ok(t.chamadas.logs.includes('disparo [seco]: receberia'));
});

test('SECO: uma segunda rodada não regrava quem já foi simulado', async () => {
  const t = montar({ modo: 'seco', quantos: 3 });
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  const r2 = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r2.processados, 0);
});

test('SECO: aplica as mesmas regras — consulta futura e SAIR saem da lista e nada é enviado', async () => {
  const t = montar({ modo: 'seco', quantos: 3, franquia: (d) => (d.id === 'd2' ? 'consulta-futura' : 'livre'), pediuSair: (d) => d.id === 'd3' });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual([r.receberia, r.descartados, r.saiu], [1, 1, 1]);
  assert.equal(t.estados.get('d2')!.estado, 'descartado');
  assert.equal(t.estados.get('d3')!.estado, 'saiu');
  assert.deepEqual(t.chamadas.enviar, []);
});

test('SECO: obedece a janela e os tetos (é assim que o seco prova os freios)', async () => {
  const noite = montar({ modo: 'seco', agora: MADRUGADA });
  const r = await rodarUnidade(noite.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.processados, 0);
  assert.match(r.parou ?? '', /fora da janela/);

  const teto = montar({ modo: 'seco', naHora: 28, quantos: 10 });
  const r2 = await rodarUnidade(teto.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r2.receberia, 2, 'só cabem 2 até os 30/h');
});

test('DESLIGADO: não faz nada, nem consulta', async () => {
  const t = montar({ modo: 'desligado' });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.processados, 0);
  assert.deepEqual(t.chamadas.enviar, []);
  assert.ok([...t.estados.values()].every((e) => !e.simuladoEm));
});

// ── MODO LIGADO ─────────────────────────────────────────────────────────────────────────────────────────────

test('LIGADO: manda, grava o id da Meta, deixa nota no cartão e conclui a onda quando acaba', async () => {
  const t = montar({ modo: 'ligado', quantos: 3 });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.mandou, 3);
  assert.equal(t.chamadas.enviar.length, 3);
  assert.equal(t.estados.get('d1')!.estado, 'enviado');
  assert.equal(t.estados.get('d1')!.wamid, 'wamid.d1');
  assert.ok(t.estados.get('d1')!.enviadoEm);
  assert.equal(t.chamadas.espelhar.length, 3);
  assert.match(t.chamadas.espelhar[0]!, /^1001\|.*Oi Pessoa1!.*Kommo não mostra/s);
  assert.deepEqual(t.chamadas.concluidas, ['o1']);
});

test('LIGADO: respeita o teto por hora da unidade e não conclui enquanto sobra gente', async () => {
  const t = montar({ modo: 'ligado', quantos: 10, naHora: 27 });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.mandou, 3, '27 de 30 já foram nesta hora');
  assert.deepEqual(t.chamadas.concluidas, []);
  const cheio = montar({ modo: 'ligado', naHora: 30 });
  const r2 = await rodarUnidade(cheio.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r2.mandou, 0);
  assert.match(r2.parou ?? '', /teto atingido/);
});

test('LIGADO: o teto é reconferido a cada envio — se outro processo gastou as vagas no meio, para', async () => {
  const t = montar({ modo: 'ligado', quantos: 6 });
  let chamadas = 0;
  t.porto.contarNaJanela = async (_u, desde) => {
    chamadas += 1;
    // 1ª rodada de contagem (início): 0. Depois que 2 saíram, "outro processo" encheu a hora.
    return t.chamadas.enviar.length >= 2 ? 30 : 0;
  };
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(t.chamadas.enviar.length, 2);
  assert.match(r.parou ?? '', /teto atingido durante a rodada/);
  assert.ok(chamadas > 2);
});

test('LIGADO: fora da janela não manda nada', async () => {
  const t = montar({ modo: 'ligado', agora: MADRUGADA });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.mandou, 0);
  assert.deepEqual(t.chamadas.enviar, []);
});

test('LIGADO: com lista de teste só esses números recebem, e a onda não conclui', async () => {
  const t = montar({ modo: 'ligado', quantos: 3, teste: [destino(2).telefone] });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(t.chamadas.enviar, [destino(2).telefone]);
  assert.equal(r.mandou, 1);
  assert.equal(t.estados.get('d1')!.estado, 'pendente');
  assert.deepEqual(t.chamadas.concluidas, []);
});

test('LIGADO sem lista de teste (vazia/ausente/ilegível) = ninguém recebe, e o log diz por quê', async () => {
  const t = montar({ modo: 'ligado', quantos: 3, teste: [] });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(t.chamadas.enviar, []);
  assert.match(r.parou ?? '', /ligada sem lista de teste/);
  assert.ok(t.chamadas.logs.some((l) => /sem lista de teste/.test(l)));
  assert.ok([...t.estados.values()].every((e) => e.estado === 'pendente'));
});

test('LIGADO: quem outro processo já reivindicou não recebe de novo', async () => {
  const t = montar({ modo: 'ligado', quantos: 3, reivindicar: (d) => d.id !== 'd2' });
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(t.chamadas.enviar.length, 2);
  assert.ok(!t.chamadas.enviar.includes(destino(2).telefone));
});

test('LIGADO: reconfere na hora — consulta marcada depois da montagem e SAIR recente seguram o envio', async () => {
  const t = montar({ modo: 'ligado', quantos: 3, franquia: (d) => (d.id === 'd1' ? 'tratamento-aberto' : 'livre'), pediuSair: (d) => d.id === 'd2' });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(t.chamadas.enviar, [destino(3).telefone]);
  assert.equal(t.estados.get('d1')!.estado, 'descartado');
  assert.equal(t.estados.get('d2')!.estado, 'saiu');
  assert.equal(r.mandou, 1);
});

test('LIGADO: franquia fora do ar na hora do envio = não manda, e a pessoa VOLTA para a fila (não é descartada)', async () => {
  const t = montar({ modo: 'ligado', quantos: 5, franquia: () => 'indisponivel' });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(t.chamadas.enviar, []);
  for (const id of ['d1', 'd2', 'd3']) {
    assert.equal(t.estados.get(id)!.estado, 'pendente', 'um soluço da franquia não condena a pessoa');
    assert.ok(!t.estados.get(id)!.enviadoEm, 'e não gasta teto (nem chegou a ser reivindicada)');
  }
  assert.match(r.parou ?? '', /sistema instável: 3 pessoas adiadas/, 'não martela as 5: para na 3ª');
  assert.equal(t.estados.get('d4')!.estado, 'pendente');
  // quando a franquia volta, a mesma pessoa recebe
  const volta = montar({ modo: 'ligado', quantos: 1 });
  assert.equal((await rodarUnidade(volta.porto, sem_pausa, UNIDADE, [ONDA])).mandou, 1);
});

test('SECO: franquia fora do ar não grava nada (nem "receberia", nem descarte)', async () => {
  const t = montar({ modo: 'seco', quantos: 2, franquia: () => 'indisponivel' });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.receberia + r.descartados, 0);
  assert.ok([...t.estados.values()].every((e) => e.estado === 'pendente' && !e.simuladoEm));
});

test('LIGADO: erro ANTES de chamar a Meta (banco, Kommo) devolve a pessoa à fila e não conta como falha da Meta', async () => {
  const t = montar({ modo: 'ligado', quantos: 2, pediuSair: (d) => { if (d.id === 'd1') throw new Error('timeout do banco'); return false; } });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(t.estados.get('d1')!.estado, 'pendente');
  assert.ok(!t.estados.get('d1')!.enviadoEm);
  assert.equal(r.falhou, 0);
  assert.equal(r.mandou, 1);
  assert.equal(t.chamadas.pausas.length, 0);
});

test('LIGADO: as conferências vêm ANTES da reivindicação (quem é barrado ou adiado nunca fica "enviando")', async () => {
  const ordem: string[] = [];
  const t = montar({ modo: 'ligado', quantos: 1, franquia: () => { ordem.push('franquia'); return 'livre'; }, reivindicar: () => { ordem.push('reivindicar'); return true; } });
  const enviar = t.porto.enviar;
  t.porto.enviar = async (...a) => { ordem.push('enviar'); return enviar(...a); };
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(ordem, ['franquia', 'reivindicar', 'enviar']);
  const barrado = montar({ modo: 'ligado', quantos: 1, franquia: () => 'consulta-futura', reivindicar: () => { throw new Error('não podia reivindicar quem foi barrado'); } });
  await rodarUnidade(barrado.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(barrado.estados.get('d1')!.estado, 'descartado');
});

test('LIGADO: cancelar ou pausar no MEIO da rodada vale para a próxima pessoa', async () => {
  const t = montar({ modo: 'ligado', quantos: 6, ondaViva: (chamada) => chamada <= 2 });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.mandou, 2, 'a 3ª consulta já viu a onda parada');
  assert.equal(t.estados.get('d3')!.estado, 'pendente');
  assert.deepEqual(t.chamadas.concluidas, []);
});

test('LIGADO: quem perdeu a disputa para outro processo não gasta vaga nem tempo', async () => {
  const t = montar({ modo: 'ligado', quantos: 3, naHora: 27, reivindicar: (d) => d.id !== 'd1' });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.processados, 3 - 1, 'só d2 e d3 contam; d1 foi pulado');
  assert.equal(r.mandou, 2);
});

test('falhas seguidas só valem DEPOIS da aprovação mais recente (consertou o token e aprovou de novo, começa limpo)', async () => {
  const t = montar({ modo: 'ligado', quantos: 1 });
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(t.chamadas.desdeDasFalhas, [ONDA.aprovadaEm]);
});

test('LIGADO: mais de 3 SAIR para a unidade — nada sai e as ondas são pausadas com o motivo', async () => {
  const t = montar({ modo: 'ligado', sairam: 4 });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.mandou, 0);
  assert.deepEqual(t.chamadas.enviar, []);
  assert.equal(t.chamadas.pausas.length, 1);
  assert.match(t.chamadas.pausas[0]!, /4 pessoas responderam SAIR/);
  // exatamente 3 ainda não para
  const ok = montar({ modo: 'ligado', sairam: 3 });
  assert.equal((await rodarUnidade(ok.porto, sem_pausa, UNIDADE, [ONDA])).mandou, 3);
});

test('o freio de SAIR vale também em SECO (a decisão não muda por não estar mandando)', async () => {
  const t = montar({ modo: 'seco', sairam: 4 });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.receberia, 0);
  assert.equal(t.chamadas.pausas.length, 1);
});

test('LIGADO: 5 falhas seguidas da Meta pausam a unidade no meio da rodada (token vencido não queima a lista)', async () => {
  const t = montar({ modo: 'ligado', quantos: 9, envio: () => ({ ok: false, wamid: null, detalhe: { error: { code: 190, message: 'token expirado' } }, incerto: false }) });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(t.chamadas.enviar.length, 5, 'parou na 5ª, não foi até a 9ª');
  assert.equal(r.falhou, 5);
  assert.equal(t.chamadas.pausas.length, 1);
  assert.equal(t.estados.get('d1')!.estado, 'falhou');
  assert.match(t.estados.get('d1')!.motivo ?? '', /Meta 190: token expirado/);
  assert.equal(t.estados.get('d1')!.enviadoEm, null, 'recusa definitiva não conta no teto: a Meta não aceitou');
});

test('LIGADO: já havia 5 falhas seguidas da rodada anterior — não manda nem a primeira', async () => {
  const t = montar({ modo: 'ligado', ultimos: ['falhou', 'falhou', 'falhou', 'falhou', 'falhou'] });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.parou, 'parada por falhas seguidas');
  assert.deepEqual(t.chamadas.enviar, []);
});

test('LIGADO: envio incerto (timeout) fica marcado, conta no teto e NÃO é reenviado', async () => {
  const t = montar({ modo: 'ligado', quantos: 1, envio: () => ({ ok: false, wamid: null, detalhe: 'TimeoutError', incerto: true }) });
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  const e = t.estados.get('d1')!;
  assert.equal(e.estado, 'falhou');
  assert.match(e.motivo ?? '', /^INCERTO/);
  assert.ok(e.enviadoEm, 'conta no teto: pode ter saído');
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(t.chamadas.enviar.length, 1, 'a segunda rodada não tenta de novo');
});

test('LIGADO: erro inesperado com uma pessoa não derruba as outras e fica marcado como incerto', async () => {
  const t = montar({ modo: 'ligado', quantos: 3, envio: (d) => { if (d.id === 'd1') throw new Error('boom'); return { ok: true, wamid: `w.${d.id}`, detalhe: {}, incerto: false }; } });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.mandou, 2);
  assert.match(t.estados.get('d1')!.motivo ?? '', /^INCERTO: erro interno/);
});

test('LIGADO: enviou mas a nota no Kommo falhou — continua enviado, só avisa no log', async () => {
  const t = montar({ modo: 'ligado', quantos: 1 });
  t.porto.espelhar = async () => {
    throw new Error('kommo fora');
  };
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(t.estados.get('d1')!.estado, 'enviado');
  assert.ok(t.chamadas.logs.some((l) => /não consegui espelhar/.test(l)));
});

test('LIGADO: aprovação com mais de 7 dias não sai (lista velha); em SECO a idade não importa', async () => {
  const velha = { ...ONDA, aprovadaEm: new Date(Date.UTC(2026, 9, 10, 15)) };
  const t = montar({ modo: 'ligado' });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [velha]);
  assert.equal(r.parou, 'aprovação vencida');
  assert.deepEqual(t.chamadas.enviar, []);
  assert.match(t.chamadas.pausas[0]!, /passou de 7 dias/);
  const seco = montar({ modo: 'seco' });
  assert.equal((await rodarUnidade(seco.porto, sem_pausa, UNIDADE, [velha])).receberia, 3);
});

test('a mensagem de erro da Meta vira uma linha legível', () => {
  assert.equal(motivoDaMeta({ ok: false, wamid: null, incerto: false, detalhe: { error: { code: 131049, message: 'm', error_data: { details: 'ecossistema saudável' } } } }), 'Meta 131049: ecossistema saudável');
  assert.match(motivoDaMeta({ ok: false, wamid: null, incerto: true, detalhe: 'TimeoutError' }), /^INCERTO: TimeoutError/);
});

// ── Retomada da onda pausada por SAIR (decisão do João, 26/10) ────────────────────────────────────────────

test('a pausa por SAIR diz a causa "sair"; falhas seguidas e aprovação vencida têm a sua (só "sair" pode ser retomada)', async () => {
  const sair = montar({ modo: 'ligado', sairam: 4, teste: null });
  await rodarUnidade(sair.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(sair.chamadas.causas, ['sair']);

  const falhas = montar({ modo: 'ligado', ultimos: ['falhou', 'falhou', 'falhou', 'falhou', 'falhou'], teste: null });
  await rodarUnidade(falhas.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(falhas.chamadas.causas, ['falhas']);

  const velha = montar({ modo: 'ligado', teste: null });
  await rodarUnidade(velha.porto, sem_pausa, UNIDADE, [{ ...ONDA, aprovadaEm: new Date(AGORA.getTime() - 8 * 86_400_000) }]);
  assert.deepEqual(velha.chamadas.causas, ['vencida']);
});

test('onda RETOMADA: os SAIR que o João já viu não pausam de novo; mais de 3 NOVOS pausam', async () => {
  const retomada = { ...ONDA, sairAceitos: 4 };
  const mesmos = montar({ modo: 'ligado', sairam: 4, teste: null, quantos: 2 });
  const r = await rodarUnidade(mesmos.porto, sem_pausa, UNIDADE, [retomada]);
  assert.deepEqual(mesmos.chamadas.pausas, [], 'os 4 já foram vistos');
  assert.equal(r.mandou, 2, 'e a onda anda');

  const tres = montar({ modo: 'ligado', sairam: 7, teste: null });
  await rodarUnidade(tres.porto, sem_pausa, UNIDADE, [retomada]);
  assert.deepEqual(tres.chamadas.pausas, [], '3 novos ainda não passam do limite (mais de 3)');

  const quatro = montar({ modo: 'ligado', sairam: 8, teste: null });
  const r4 = await rodarUnidade(quatro.porto, sem_pausa, UNIDADE, [retomada]);
  assert.equal(quatro.chamadas.pausas.length, 1, '4 novos param de novo');
  assert.match(quatro.chamadas.pausas[0]!, /8 pessoas responderam SAIR .*além das 4 que o João já viu/);
  assert.equal(r4.mandou, 0);
});

test('uma onda NOVA na mesma campanha não herda a folga de outra retomada (vale a menor base)', async () => {
  const t = montar({ modo: 'ligado', sairam: 4, teste: null });
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [{ ...ONDA, sairAceitos: 4 }, { ...ONDA, id: 'o2', sairAceitos: 0 }]);
  assert.equal(t.chamadas.pausas.length, 1);
  assert.deepEqual(t.chamadas.causas, ['sair']);
});

// ── o que o sênior achou no #126 (26/10) ──────────────────────────────────────────────────────────────────

test('3 pessoas que a franquia não deixa conferir NÃO travam a onda: vão para o fim da fila e as outras 17 andam (antes: 0 de 20 em 5 rodadas)', async () => {
  const presas = new Set(['d1', 'd2', 'd3']);
  const t = montar({ modo: 'seco', quantos: 20, franquia: (d) => (presas.has(d.id) ? 'indisponivel' : 'livre') });
  let receberia = 0;
  for (let rodada = 1; rodada <= 5; rodada++) receberia += (await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA])).receberia;
  assert.equal(receberia, 17, 'as 17 que dá para conferir foram todas processadas');
  for (const id of presas) assert.equal(t.estados.get(id)!.estado, 'pendente', 'e as 3 continuam na fila, não descartadas');
  assert.match(String(t.estados.get('d1')!.motivo), /^adiado: a franquia não respondeu/, 'com o motivo gravado');
});

test('adiado em LIGADO também vai para o fim e fica registrado; ninguém é enviado sem conferência', async () => {
  const t = montar({ modo: 'ligado', quantos: 8, teste: null, franquia: (d) => (d.id === 'd1' ? 'indisponivel' : 'livre') });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.adiados, 1);
  assert.equal(r.mandou, 7);
  assert.ok(!t.chamadas.enviar.includes(destino(1).telefone));
  assert.equal(t.estados.get('d1')!.estado, 'pendente');
});

test('rodadasSemAndar: conta rodadas só com gente adiada; zera quando alguém anda; rodada que não tentou ninguém não conta nem zera', () => {
  const vazia = { adiados: 0, mandou: 0, receberia: 0, falhou: 0, saiu: 0, descartados: 0 };
  assert.equal(rodadasSemAndar(0, { ...vazia, adiados: 3 }), 1);
  assert.equal(rodadasSemAndar(4, { ...vazia, adiados: 3 }), 5);
  assert.equal(rodadasSemAndar(4, vazia), 4, 'fora da janela: nem conta nem zera');
  for (const campo of ['mandou', 'receberia', 'falhou', 'saiu', 'descartados'] as const) assert.equal(rodadasSemAndar(4, { ...vazia, adiados: 2, [campo]: 1 }), 0, campo);
});

test('APROVAÇÃO DADA EM SECO NÃO VALE PARA ENVIO REAL: ao ligar a unidade a onda volta para aprovação e nada sai', async () => {
  for (const modo of ['seco', 'desligado', null]) {
    const t = montar({ modo: 'ligado', quantos: 3, teste: null });
    const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [{ ...ONDA, aprovadaModo: modo }]);
    assert.deepEqual(t.chamadas.enviar, [], `aprovada em ${modo}: nada é enviado`);
    assert.deepEqual(t.chamadas.espelhar, []);
    assert.equal(r.mandou, 0);
    assert.equal(t.chamadas.devolvidas.length, 1, `aprovada em ${modo}: devolvida para o João aprovar de novo`);
    assert.match(t.chamadas.devolvidas[0]!, /^o1\|.*LIGADA.*aprove de novo/);
    assert.match(r.parou ?? '', /aprovação dada em modo seco/);
  }
});

test('aprovada com a unidade LIGADA continua valendo; em SECO a modalidade da aprovação não importa (o seco nunca manda)', async () => {
  const ligada = montar({ modo: 'ligado', quantos: 2, teste: null });
  assert.equal((await rodarUnidade(ligada.porto, sem_pausa, UNIDADE, [ONDA])).mandou, 2);
  assert.deepEqual(ligada.chamadas.devolvidas, []);
  const seca = montar({ modo: 'seco', quantos: 2 });
  const r = await rodarUnidade(seca.porto, sem_pausa, UNIDADE, [{ ...ONDA, aprovadaModo: 'seco' }]);
  assert.equal(r.receberia, 2);
  assert.deepEqual(seca.chamadas.devolvidas, [], 'seco não devolve nada');
});

test('na mesma unidade, só a onda aprovada em seco volta; a aprovada ligada segue', async () => {
  const t = montar({ modo: 'ligado', quantos: 2, teste: null });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [{ ...ONDA, id: 'o-seco', aprovadaModo: 'seco' }, ONDA]);
  assert.equal(t.chamadas.devolvidas.length, 1);
  assert.match(t.chamadas.devolvidas[0]!, /^o-seco\|/);
  assert.equal(r.mandou, 2);
});

test('LIMITE DE TAXA da Meta = tentar de novo depois: a pessoa fica na fila, não é falha, não pausa a unidade e a rodada acaba', async () => {
  const limite: ResultadoDoTemplate = { ok: false, wamid: null, detalhe: { error: { code: 130429, message: 'Rate limit hit' } }, incerto: false, limiteDeTaxa: true };
  const t = montar({ modo: 'ligado', quantos: 5, teste: null, envio: () => limite });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.match(r.parou ?? '', /limite de taxa/);
  assert.equal(t.chamadas.enviar.length, 1, 'parou na primeira, sem martelar a Meta');
  assert.equal(r.falhou, 0, 'não conta como falha');
  assert.deepEqual(t.chamadas.pausas, [], 'nem pausa a unidade');
  const d1 = t.estados.get('d1')!;
  assert.equal(d1.estado, 'pendente');
  assert.equal(d1.enviadoEm, null, 'e não conta no teto: nada saiu');
  assert.match(String(d1.motivo), /limite de taxa da Meta: tento de novo depois/);
  // depois a Meta libera e a mesma pessoa sai
  const livre = montar({ modo: 'ligado', quantos: 1, teste: null });
  assert.equal((await rodarUnidade(livre.porto, sem_pausa, UNIDADE, [ONDA])).mandou, 1);
});

test('uma recusa DEFINITIVA da Meta (não é limite de taxa) continua sendo falha', async () => {
  const recusa: ResultadoDoTemplate = { ok: false, wamid: null, detalhe: { error: { code: 131026, message: 'Message undeliverable' } }, incerto: false };
  const t = montar({ modo: 'ligado', quantos: 1, teste: null, envio: () => recusa });
  const r = await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.equal(r.falhou, 1);
  assert.equal(t.estados.get('d1')!.estado, 'falhou');
});
