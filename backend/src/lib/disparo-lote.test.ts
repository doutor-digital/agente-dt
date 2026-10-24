import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREIOS_PADRAO, type Freios } from './disparo/freios.js';
import { rodarUnidade, motivoDaMeta, type DadosDeGravacao, type Destino, type Modo, type OndaNoLote, type Porto, type UnidadeNoLote } from './disparo/lote.js';
import type { ResultadoDoTemplate } from './whatsapp-meta.js';
import type { SituacaoNaFranquia } from './disparo/regras.js';

// Quarta 21/10/2026, 09h30 em São Paulo (dentro da janela).
const AGORA = new Date(Date.UTC(2026, 9, 21, 12, 30));
const MADRUGADA = new Date(Date.UTC(2026, 9, 21, 6, 0));
const sem_pausa: Freios = { ...FREIOS_PADRAO, pausaMs: 0 };
const UNIDADE: UnidadeNoLote = { id: 'u1', slug: 'doutor-hernia-canaa', nome: 'Doutor Hérnia Canaã', fuso: 'America/Sao_Paulo' };
const ONDA: OndaNoLote = { id: 'o1', campanhaId: 'c1', aprovadaEm: new Date(Date.UTC(2026, 9, 20, 15)), template: 'canaa_resgate', idioma: 'pt_BR', textoModelo: 'Oi {{1}}!', variaveis: ['primeiroNome'], cabecalho: null };

function destino(n: number): Destino {
  return { id: `d${n}`, ondaId: 'o1', campanhaId: 'c1', unitId: 'u1', telefone: `55639910210${String(n).padStart(2, '0')}`, chave: `6391021${String(n).padStart(3, '0')}`, nome: `Pessoa${n}`, nomeCompleto: `Pessoa${n} Silva`, kommoLeadId: 1000 + n };
}

/** Um Porto de mentira que registra TUDO que sai da casa. */
function montar(opcoes: { modo: Modo; quantos?: number; agora?: Date; franquia?: (d: Destino) => SituacaoNaFranquia; sairam?: number; naHora?: number; noDia?: number; teste?: string[] | null; envio?: (d: Destino) => ResultadoDoTemplate | Promise<ResultadoDoTemplate>; pediuSair?: (d: Destino) => boolean; reivindicar?: (d: Destino) => boolean; ultimos?: Array<'enviado' | 'falhou'>; ondaViva?: (chamada: number) => boolean }) {
  const estados = new Map<string, Omit<DadosDeGravacao, 'estado'> & { estado: string }>();
  const todos = Array.from({ length: opcoes.quantos ?? 3 }, (_, i) => destino(i + 1));
  todos.forEach((d) => estados.set(d.id, { estado: 'pendente' }));
  let consultasDeOnda = 0;
  const desdeDasFalhas: Date[] = [];
  const chamadas = { desdeDasFalhas, enviar: [] as string[], espelhar: [] as string[], pausas: [] as string[], concluidas: [] as string[], logs: [] as string[] };
  const porto: Porto = {
    agora: () => opcoes.agora ?? AGORA,
    modoDaUnidade: () => opcoes.modo,
    listaDeTeste: () => (opcoes.teste ? new Set(opcoes.teste) : null),
    contarNaJanela: async (_u, desde) => (AGORA.getTime() - desde.getTime() <= 3_600_000 ? (opcoes.naHora ?? 0) : (opcoes.noDia ?? 0)),
    pendentes: async (_o, modo, limite, so) =>
      todos
        .filter((d) => estados.get(d.id)!.estado === 'pendente' && (modo === 'ligado' || !estados.get(d.id)!.simuladoEm) && (!so || so.has(d.telefone)))
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
    gravar: async (id, dados) => void Object.assign(estados.get(id)!, dados),
    pausarOndas: async (_u, _c, motivo) => void chamadas.pausas.push(motivo),
    pausarOnda: async (_id, motivo) => void chamadas.pausas.push(motivo),
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

test('LIGADO: lista de teste vazia/ilegível = ninguém recebe (não "todo mundo")', async () => {
  const t = montar({ modo: 'ligado', quantos: 3, teste: [] });
  await rodarUnidade(t.porto, sem_pausa, UNIDADE, [ONDA]);
  assert.deepEqual(t.chamadas.enviar, []);
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
    assert.equal(t.estados.get(id)!.enviadoEm, null, 'e não gasta teto');
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
  assert.equal(t.estados.get('d1')!.enviadoEm, null);
  assert.equal(r.falhou, 0);
  assert.equal(r.mandou, 1);
  assert.equal(t.chamadas.pausas.length, 0);
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
