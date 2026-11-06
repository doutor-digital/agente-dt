/**
 * A rodada da Faxina do mês: uma vez por unidade por mês, só na janela, Telegram com falha não derruba, sob demanda ignora a
 * janela. E o que a faxina dispara das automações que já existem: no seco, nada que escreva; desligada só relata.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { _semearParaTeste } from './automacoes-estado.js';
import {
  _esquecerFeitas,
  etapasDaFaxina,
  motivosDaFaxina,
  UNIDADES_POR_LOTE,
  iniciarFaxinaSobDemanda,
  rodarFaxinaDoMes,
  type AlvoDaFaxina,
  type ChamadasDasAutomacoes,
  type DepsDaRodada,
} from './faxina-do-mes-worker.js';
import { resultadoVazio, type CtxFaxina } from './faxina-do-mes.js';

const DIA1_3H = new Date('2026-12-01T06:00:00Z'); // 03:00 em São Paulo, dia 1
const DIA2_3H = new Date('2026-12-02T06:00:00Z');

const alvo = (slug: string, modo: 'ligado' | 'seco' = 'ligado'): AlvoDaFaxina => ({ slug, nome: slug.toUpperCase(), subdominio: slug, modo, cuidaDaConta: true, contaDividida: false });

function depsDaRodada(o: { lider?: () => boolean; alvos?: AlvoDaFaxina[]; agora?: Date; lease?: (nome: string, ttl: number) => 'minha' | 'de-outro' | 'erro'; enviar?: (t: string) => Promise<boolean>; faxina?: DepsDaRodada['faxina'] } = {}) {
  const rodadas: string[] = [];
  const leases: Array<[string, number]> = [];
  const enviados: string[] = [];
  const deps: DepsDaRodada = {
    alvos: async (soSlug) => (o.alvos ?? [alvo('timbo'), alvo('mossoro')]).filter((a) => !soSlug || a.slug === soSlug),
    reivindicar: async (nome, ttl) => {
      leases.push([nome, ttl]);
      return o.lease ? o.lease(nome, ttl) : 'minha';
    },
    faxina: o.faxina ?? (async (a) => {
      rodadas.push(a.slug);
      const r = resultadoVazio(a.slug, a.nome, a.subdominio, a.modo);
      r.tarefas.fechadas = 4;
      return r;
    }),
    enviar: async (t) => {
      enviados.push(t);
      return o.enviar ? o.enviar(t) : true;
    },
    agora: () => o.agora ?? DIA1_3H,
    lider: o.lider ?? (() => true),
  };
  return { deps, rodadas, leases, enviados };
}

beforeEach(() => _esquecerFeitas());

// ─── a rodada ─────────────────────────────────────────────────────────────────────────────────────

test('dia 1 às 3h: roda cada unidade UMA vez, na ordem, e manda UM relatório com o total da rede', async () => {
  const { deps, rodadas, enviados } = depsDaRodada();
  const d = await rodarFaxinaDoMes({}, deps);
  assert.deepEqual(rodadas, ['timbo', 'mossoro']);
  assert.equal(d.enviado, true);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /TOTAL DA REDE \(2 unidades: 2 ligadas, 0 só no papel\)/);
  assert.match(enviados[0], /TIMBO, novembro: /);
});

test('uma vez por mês: o tick seguinte não repete (memória) e outro processo também não (trava no banco)', async () => {
  const a = depsDaRodada();
  await rodarFaxinaDoMes({}, a.deps);
  await rodarFaxinaDoMes({}, a.deps);
  assert.deepEqual(a.rodadas, ['timbo', 'mossoro'], 'segunda rodada no mesmo processo não repete');

  _esquecerFeitas(); // como se fosse outro processo depois de um deploy
  const outro = depsDaRodada({ lease: () => 'de-outro' });
  const d = await rodarFaxinaDoMes({}, outro.deps);
  assert.deepEqual(outro.rodadas, [], 'a trava do banco diz que já foi feita');
  assert.equal(d.resultados.length, 0);
  assert.equal(outro.enviados.length, 0, 'sem unidade rodada, sem relatório');
});

test('a trava vira FEITA (40 dias) assim que a UNIDADE termina, antes do relatório: deploy no meio não repete unidade', async () => {
  const eventos: string[] = [];
  const base = depsDaRodada({ alvos: [alvo('timbo'), alvo('mossoro')], enviar: async () => { eventos.push('enviou'); return false; } });
  const deps: DepsDaRodada = {
    ...base.deps,
    reivindicar: async (nome, ttl) => { eventos.push(`${ttl > 24 * 3600_000 ? 'feita' : 'rodando'}:${nome.split(':').pop()}`); return 'minha'; },
  };
  await rodarFaxinaDoMes({}, deps);
  assert.deepEqual(eventos, ['rodando:timbo', 'feita:timbo', 'rodando:mossoro', 'feita:mossoro', 'enviou']);
  const outra = await rodarFaxinaDoMes({}, deps);
  assert.equal(outra.resultados.length, 0, 'segunda rodada no mesmo processo não refaz');
});

test('processo morre DEPOIS de uma unidade terminar e ANTES do relatório: a unidade não é refeita por outro processo (trava de 40 dias)', async () => {
  const travas = new Map<string, number>();
  const base = depsDaRodada({ alvos: [alvo('timbo'), alvo('mossoro')] });
  let faltam = 1; // a 2ª unidade "mata" o processo
  const morre: DepsDaRodada = {
    ...base.deps,
    reivindicar: async (nome, ttl) => { travas.set(nome, ttl); return 'minha'; },
    faxina: async (a, e) => { if (faltam-- <= 0) throw new Error('processo morreu'); return base.deps.faxina(a, e); },
  };
  await rodarFaxinaDoMes({}, morre);
  // a trava da 1ª é de 40 dias; a da 2ª também foi esticada (a falha da unidade vira erro no relatório, não repetição)
  assert.ok((travas.get('faxina-do-mes:2026-12:timbo') ?? 0) > 24 * 3600_000);
  // um processo novo, vendo as travas de outro dono, não refaz nada
  _esquecerFeitas();
  const novo = depsDaRodada({ lease: () => 'de-outro' });
  assert.equal((await rodarFaxinaDoMes({}, novo.deps)).resultados.length, 0);
});

/** Relógio que anda: a faxina toma `agora` de `deps.agora()`. */
function comRelogio(base: ReturnType<typeof depsDaRodada>, relogio: { t: number }): DepsDaRodada {
  return { ...base.deps, agora: () => new Date(relogio.t) };
}
const MIN = 60_000;

test('LAÇO: unidade interrompida NÃO é refeita a cada tick de 10 min (a trava devolve "minha" ao mesmo dono): só depois dos 90 min, e no máximo 2 rodadas por noite', async () => {
  const relogio = { t: DIA1_3H.getTime() };
  const leases: Array<[string, number]> = [];
  const base = depsDaRodada({ alvos: [alvo('timbo')] });
  let rodadas = 0;
  const deps: DepsDaRodada = {
    ...comRelogio(base, relogio),
    reivindicar: async (n, ttl) => { leases.push([n, ttl]); return 'minha'; }, // o mesmo dono: SEMPRE minha
    faxina: async (a) => {
      rodadas++;
      const r = resultadoVazio(a.slug, a.nome, a.subdominio, a.modo);
      r.interrompida = true; // o Kommo pediu calma toda vez
      return r;
    },
  };
  // 30 ticks de 10 minutos = 5 h de janela (3h às 7h... a janela fecha às 7h, o relógio vai até 7h59)
  const relatorios: number[] = [];
  for (let i = 0; i < 30; i++) {
    const d = await rodarFaxinaDoMes({}, deps);
    relatorios.push(d.mensagens.length);
    relogio.t += 10 * MIN;
  }
  assert.equal(rodadas, 2, 'rodada 1 às 3h00 e rodada 2 depois dos 90 min; depois desiste');
  assert.equal(relatorios.filter((n) => n > 0).length, 2, 'no máximo 1 relatório por rodada: 2 por unidade por noite');
  assert.equal(leases.filter(([, ttl]) => ttl > 24 * 3600_000).length, 1, 'a última rodada interrompida desiste e ganha a trava de 40 dias');
});

test('interrompida uma vez e a retomada conclui: 2 rodadas, trava de 40 dias, e o aviso de «desisti» NÃO aparece', async () => {
  const relogio = { t: DIA1_3H.getTime() };
  const base = depsDaRodada({ alvos: [alvo('timbo')] });
  let rodadas = 0;
  const deps: DepsDaRodada = {
    ...comRelogio(base, relogio),
    faxina: async (a) => {
      const r = resultadoVazio(a.slug, a.nome, a.subdominio, a.modo);
      r.interrompida = ++rodadas === 1;
      return r;
    },
  };
  await rodarFaxinaDoMes({}, deps);
  relogio.t += 30 * MIN;
  assert.equal((await rodarFaxinaDoMes({}, deps)).resultados.length, 0, '30 min depois: ainda dentro dos 90 min');
  relogio.t += 61 * MIN;
  const d = await rodarFaxinaDoMes({}, deps);
  assert.equal(d.resultados.length, 1);
  assert.equal(d.resultados[0].avisos.some((a) => /desisti/.test(a)), false);
  relogio.t += 10 * MIN;
  assert.equal((await rodarFaxinaDoMes({}, deps)).resultados.length, 0, 'concluída: não volta');
  assert.equal(rodadas, 2);
});

test('o TOTAL da rodada de retomada é o da REDE do mês (não só das unidades retomadas)', async () => {
  const relogio = { t: DIA1_3H.getTime() };
  const base = depsDaRodada({ alvos: [alvo('a'), alvo('b'), alvo('c')], enviar: async () => true });
  const enviados: string[] = [];
  let rodadasB = 0;
  const deps: DepsDaRodada = {
    ...comRelogio(base, relogio),
    enviar: async (t) => { enviados.push(t); return true; },
    faxina: async (al) => {
      const r = resultadoVazio(al.slug, al.nome, al.subdominio, al.modo);
      r.tarefas.fechadas = 3;
      if (al.slug === 'b') r.interrompida = ++rodadasB === 1;
      return r;
    },
  };
  await rodarFaxinaDoMes({}, deps);
  relogio.t += 95 * MIN;
  await rodarFaxinaDoMes({}, deps);
  assert.equal(enviados.length, 2);
  assert.match(enviados[1], /TOTAL DA REDE \(3 unidades/);
  assert.match(enviados[1], /12 tarefas velhas fechadas/, 'a: 3 + b: 3+3 (as duas rodadas) + c: 3');
  assert.match(enviados[1], /rodada de retomada/, 'a rodada de retomada avisa que o total soma as duas');
});

test('interrupção por PERDA DE LIDERANÇA não gasta uma das 2 rodadas da noite', async () => {
  const relogio = { t: DIA1_3H.getTime() };
  const base = depsDaRodada({ alvos: [alvo('timbo')] });
  let n = 0;
  const deps: DepsDaRodada = {
    ...comRelogio(base, relogio),
    faxina: async (a) => {
      const r = resultadoVazio(a.slug, a.nome, a.subdominio, a.modo);
      n++;
      r.interrompida = n <= 2;
      r.perdeuLideranca = n === 1; // 1ª: deploy; 2ª: Kommo
      return r;
    },
  };
  await rodarFaxinaDoMes({}, deps);
  relogio.t += 95 * MIN;
  await rodarFaxinaDoMes({}, deps);
  relogio.t += 95 * MIN;
  const d = await rodarFaxinaDoMes({}, deps);
  assert.equal(n, 3, 'a 3ª rodada acontece: a 1ª (deploy) não contou');
  assert.equal(d.resultados[0].avisos.some((a) => /desisti/.test(a)), false);
});

test('falha ao gravar a trava mensal de 40 dias é REGISTRADA no relatório (e a unidade não repete neste processo)', async () => {
  const base = depsDaRodada({ alvos: [alvo('timbo')] });
  const deps: DepsDaRodada = { ...base.deps, reivindicar: async (_n, ttl) => (ttl > 24 * 3600_000 ? 'erro' : 'minha') };
  const d = await rodarFaxinaDoMes({}, deps);
  assert.match(d.resultados[0].avisos.join('\n'), /não consegui gravar a trava mensal/);
  assert.match(d.mensagens.join('\n'), /não consegui gravar a trava mensal/);
  assert.equal((await rodarFaxinaDoMes({}, deps)).resultados.length, 0);
});

test('perda de liderança: «Não deu tempo» não lista unidades que JÁ terminaram neste mês', async () => {
  const feita = depsDaRodada({ alvos: [alvo('a')] });
  await rodarFaxinaDoMes({}, feita.deps); // a termina
  const { deps } = depsDaRodada({ alvos: [alvo('a'), alvo('b'), alvo('c')], lider: () => false });
  const d = await rodarFaxinaDoMes({}, deps);
  assert.deepEqual(d.naoComecaram, ['B', 'C']);
});

test('perdeu a liderança no meio: para na hora, sem pegar a próxima unidade, e diz quem ficou', async () => {
  let n = 0;
  const { deps, rodadas } = depsDaRodada({ alvos: [alvo('a'), alvo('b'), alvo('c')], lider: () => n++ < 1 });
  const d = await rodarFaxinaDoMes({}, deps);
  assert.deepEqual(rodadas, ['a']);
  assert.deepEqual(d.naoComecaram, ['B', 'C']);
});

test('em lotes: relatório sai a cada UNIDADES_POR_LOTE unidades (sem total) e o último traz o TOTAL de todas', async () => {
  const slugs = Array.from({ length: UNIDADES_POR_LOTE + 2 }, (_, i) => `u${i}`);
  const { deps, enviados, leases } = depsDaRodada({ alvos: slugs.map((s) => alvo(s)) });
  const d = await rodarFaxinaDoMes({}, deps);
  assert.equal(d.resultados.length, slugs.length);
  assert.equal(enviados.length, 2);
  assert.doesNotMatch(enviados[0], /TOTAL DA REDE/);
  assert.match(enviados[1], new RegExp(`TOTAL DA REDE \\(${slugs.length} unidades`));
  assert.equal(leases.filter(([, ttl]) => ttl > 24 * 3600_000).length, slugs.length, 'todas marcadas como feitas');
});

test('lote exato: o total sai sozinho no fim, sem repetir unidade', async () => {
  const slugs = Array.from({ length: UNIDADES_POR_LOTE }, (_, i) => `v${i}`);
  const { deps, enviados } = depsDaRodada({ alvos: slugs.map((s) => alvo(s)) });
  await rodarFaxinaDoMes({}, deps);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /TOTAL DA REDE/);
});

test('Telegram com falha (recusou ou lançou) NÃO derruba a faxina: o resultado continua e o relatório fica no desfecho', async () => {
  for (const enviar of [async () => false, async () => { throw new Error('rede caiu'); }]) {
    _esquecerFeitas();
    const { deps } = depsDaRodada({ enviar });
    const d = await rodarFaxinaDoMes({}, deps);
    assert.equal(d.resultados.length, 2);
    assert.equal(d.enviado, false);
    assert.ok(d.mensagens.length >= 1, 'o texto existe e vai para o log');
  }
});

test('fora do dia 1 (ou fora das 2h–7h) a rodada de verdade não roda nada', async () => {
  const dia2 = depsDaRodada({ agora: DIA2_3H });
  const d = await rodarFaxinaDoMes({}, dia2.deps);
  assert.deepEqual(dia2.rodadas, []);
  assert.deepEqual(d.naoComecaram, ['TIMBO', 'MOSSORO']);
  assert.equal(dia2.leases.length, 0, 'nem pega trava');
  const tarde = depsDaRodada({ agora: new Date('2026-12-01T12:00:00Z') });
  await rodarFaxinaDoMes({}, tarde.deps);
  assert.deepEqual(tarde.rodadas, []);
});

test('sob demanda: ignora a janela e a trava mensal, roda só a unidade pedida e avisa no cabeçalho', async () => {
  const { deps, rodadas, leases, enviados } = depsDaRodada({ agora: DIA2_3H });
  await rodarFaxinaDoMes({ soSlug: 'timbo', sobDemanda: true }, deps);
  await rodarFaxinaDoMes({ soSlug: 'timbo', sobDemanda: true }, deps);
  assert.deepEqual(rodadas, ['timbo', 'timbo'], 'pode rodar de novo à vontade');
  assert.equal(leases.length, 0);
  assert.match(enviados[0], /rodada sob demanda/);
});

test('sob demanda com telegram:false não manda mensagem', async () => {
  const { deps, enviados } = depsDaRodada({ alvos: [alvo('timbo')] });
  const d = await rodarFaxinaDoMes({ sobDemanda: true, telegram: false }, deps);
  assert.equal(enviados.length, 0);
  assert.equal(d.mensagens.length, 1);
});

test('banco fora do ar na hora da trava: NÃO roda aquela unidade (silêncio é melhor que repetir)', async () => {
  const { deps, rodadas } = depsDaRodada({ lease: () => 'erro' });
  await rodarFaxinaDoMes({}, deps);
  assert.deepEqual(rodadas, []);
});

test('unidade que explode vira erro no relatório e a rodada segue para a próxima', async () => {
  const { deps, rodadas } = depsDaRodada({
    faxina: async (a) => {
      if (a.slug === 'timbo') throw new Error('Kommo caiu');
      rodadas.push(a.slug);
      return resultadoVazio(a.slug, a.nome, a.subdominio, a.modo);
    },
  });
  const d = await rodarFaxinaDoMes({}, deps);
  assert.deepEqual(rodadas, ['mossoro']);
  assert.match(d.resultados[0].erros[0], /Kommo caiu/);
  assert.match(d.mensagens.join('\n'), /Com erro em: TIMBO/);
});

test('seco: o relatório diz «faria» e a trava mensal vale igual (o seco também gasta o mês)', async () => {
  const { deps, enviados } = depsDaRodada({ alvos: [alvo('timbo', 'seco')] });
  await rodarFaxinaDoMes({}, deps);
  assert.match(enviados[0], /SÓ NO PAPEL/);
  assert.match(enviados[0], /faria fechar 4 tarefas velhas/);
});

// ─── o que a faxina dispara das automações que já existem ────────────────────────────────────────

const UNIT = { id: 'u1', slug: 'timbo-test' } as unknown as Unit;
const ctx = (modo: 'ligado' | 'seco'): CtxFaxina => ({ slug: UNIT.slug, nome: 'Timbó', subdominio: 'timbosc', modo, cuidaDaConta: true, contaDividida: false, agoraEpoch: 1 });

const AGORA_MS = 1_800_000_000_000;
function chamadas(o: { parados?: { minAtras?: number; movidos?: number } | null; sync?: { minAtras?: number; movimentos?: number; escritas?: number; simulados?: Record<string, number> } | null; noPapel?: number; falha?: boolean } = {}) {
  const feitas: string[] = [];
  const c: ChamadasDasAutomacoes = {
    ultimoParados: () => (o.parados === null ? null : { em: AGORA_MS - (o.parados?.minAtras ?? 10) * 60_000, resumo: { movidos: o.parados?.movidos ?? 0 } }),
    ultimoSync: () =>
      o.sync === null ? null : { em: new Date(AGORA_MS - (o.sync?.minAtras ?? 5) * 60_000).toISOString(), movimentos: o.sync?.movimentos ?? 0, escritas: o.sync?.escritas ?? 0, simulados: o.sync?.simulados, semLead: 2 },
    motivos: async () => {
      feitas.push('motivos');
      if (o.falha) throw new Error('banco caiu');
      return { executou: true, estado: 'ligado', candidatos: 3, gravados: 3, erros: 0 };
    },
    noPapel: async () => {
      if (o.falha) throw new Error('banco caiu');
      return o.noPapel ?? 0;
    },
    agora: () => AGORA_MS,
  };
  return { c, feitas };
}

const estados = (e: Record<string, 'ligado' | 'seco' | 'desligado'>) => _semearParaTeste(Object.entries(e).map(([automacao, estado]) => ({ slug: UNIT.slug, automacao, estado })));

test('passos 3 e 4 só LEEM a última varredura: ligada mostra o que ELA moveu (a faxina não move nem dispara passada)', async () => {
  estados({ parados: 'ligado', 'franquia-sync': 'ligado' });
  const { c, feitas } = chamadas({ parados: { movidos: 5 }, sync: { movimentos: 3, escritas: 14 } });
  const r = await etapasDaFaxina(ctx('ligado'), UNIT, c);
  assert.deepEqual(feitas, [], 'nenhuma automação foi disparada');
  assert.deepEqual(r.automacoes.map((a) => [a.id, a.executou, a.movidos]), [['parados', true, 5], ['franquia-sync', true, 3]]);
  assert.equal(r.camposGravados, 14);
  assert.match(r.automacoes[0].nota ?? '', /lido da última varredura, há 10 min/);
});

test('BLOQUEANTE do sênior: faxina SECA com franquia-move / franquia-revisao LIGADOS não aciona o sincronizador — só lê o resumo', async () => {
  for (const ligada of ['franquia-move', 'franquia-revisao', 'franquia-sync']) {
    estados({ parados: 'seco', 'franquia-sync': ligada === 'franquia-sync' ? 'ligado' : 'seco', [ligada]: 'ligado' });
    const { c, feitas } = chamadas({ sync: { movimentos: 2, simulados: { 'AGENDADO → PERDIDO': 4 } }, noPapel: 1 });
    const r = await etapasDaFaxina(ctx('seco'), UNIT, c);
    // `ChamadasDasAutomacoes` nem TEM como disparar sincronizador ou parados: o contrato é só leitura
    assert.deepEqual(Object.keys(c).sort(), ['agora', 'motivos', 'noPapel', 'ultimoParados', 'ultimoSync']);
    assert.deepEqual(feitas, []);
    const s = r.automacoes.find((a) => a.id === 'franquia-sync');
    assert.deepEqual([s?.movidos, s?.moveria], [2, 4], 'mostra o que a automação JÁ fez/faria na varredura normal dela');
  }
});

test('faxina SECA + motivo-perdido-ia LIGADO: NÃO dispara (gravaria de verdade)', async () => {
  estados({ 'motivo-perdido-ia': 'ligado' });
  const { c, feitas } = chamadas();
  const m = await motivosDaFaxina(ctx('seco'), UNIT, [UNIT], c);
  assert.deepEqual(feitas, []);
  assert.equal(m.executou, false);
});

test('automação em SÓ NO PAPEL: conta o «moveria» (das linhas que a varredura refrescou)', async () => {
  estados({ parados: 'seco', 'franquia-sync': 'seco' });
  const { c } = chamadas({ noPapel: 7, sync: { simulados: { 'AGENDADO → PERDIDO': 2, 'COMPARECEU → EM ESPERA': 1 } } });
  const r = await etapasDaFaxina(ctx('ligado'), UNIT, c);
  const [p, s] = r.automacoes;
  assert.deepEqual([p.moveria, p.movidos], [7, 0]);
  assert.deepEqual([s.moveria, s.movidos], [3, 0]);
});

test('automação DESLIGADA só relata o que o papel dizia e nunca é lida como ativa', async () => {
  estados({ parados: 'desligado', 'franquia-sync': 'desligado', 'motivo-perdido-ia': 'desligado' });
  const { c, feitas } = chamadas({ noPapel: 9 });
  const r = await etapasDaFaxina(ctx('ligado'), UNIT, c);
  const m = await motivosDaFaxina(ctx('ligado'), UNIT, [UNIT], c);
  assert.deepEqual(feitas, []);
  assert.deepEqual(r.automacoes.map((a) => [a.estado, a.executou, a.movidos, a.moveria]), [['desligado', false, 0, 9], ['desligado', false, 0, 9]]);
  assert.equal(m.executou, false);
});

test('motivo-perdido-ia: só onde está ligado; ligado grava, no papel «gravaria»', async () => {
  estados({ 'motivo-perdido-ia': 'ligado' });
  const ligado = await motivosDaFaxina(ctx('ligado'), UNIT, [UNIT], chamadas().c);
  assert.deepEqual([ligado.gravados, ligado.gravaria], [3, 0]);
  estados({ 'motivo-perdido-ia': 'seco' });
  const seco = await motivosDaFaxina(ctx('ligado'), UNIT, [UNIT], chamadas().c);
  assert.deepEqual([seco.gravados, seco.gravaria], [0, 3]);
});

test('sem resumo ou resumo velho demais: diz isso, não inventa número', async () => {
  estados({ parados: 'ligado', 'franquia-sync': 'ligado' });
  const sem = await etapasDaFaxina(ctx('ligado'), UNIT, chamadas({ parados: null, sync: null }).c);
  assert.ok(sem.automacoes.every((a) => !a.executou && /sem resumo de varredura/.test(a.nota ?? '')));
  const velho = await etapasDaFaxina(ctx('ligado'), UNIT, chamadas({ parados: { minAtras: 600, movidos: 9 }, sync: { minAtras: 600, movimentos: 9 } }).c);
  assert.ok(velho.automacoes.every((a) => !a.executou && a.movidos === 0 && /velha demais/.test(a.nota ?? '')));
});

test('erro ao ler UMA automação não derruba as outras: vira nota dela', async () => {
  estados({ parados: 'seco', 'franquia-sync': 'ligado', 'motivo-perdido-ia': 'ligado' });
  const { c } = chamadas({ falha: true, sync: { movimentos: 4 } });
  const r = await etapasDaFaxina(ctx('ligado'), UNIT, c);
  assert.match(r.automacoes[0].nota ?? '', /não consegui ler/); // parados em seco precisou do banco, que caiu
  assert.equal(r.automacoes[1].movidos, 4, 'o sincronizador foi lido normalmente');
  const m = await motivosDaFaxina(ctx('ligado'), UNIT, [UNIT], c);
  assert.match(m.nota ?? '', /não consegui rodar/);
});

// ─── sob demanda: 202 só quando algo vai rodar ───────────────────────────────────────────────────

test('sob demanda: desligada ou sem alvo (sem Kommo) = 422; já rodando ou não é o líder = 409; só então 202 (iniciado)', async () => {
  const SLUG = 'sob-demanda-test';
  const estado = (e: 'ligado' | 'seco' | 'desligado') => _semearParaTeste([{ slug: SLUG, automacao: 'faxina-do-mes', estado: e }]);
  const { deps } = depsDaRodada({ alvos: [alvo(SLUG)] });

  estado('desligado');
  assert.deepEqual((({ iniciado, status }) => ({ iniciado, status }))(await iniciarFaxinaSobDemanda(SLUG, { telegram: false }, deps)), { iniciado: false, status: 422 });

  estado('seco');
  const semAlvo: DepsDaRodada = { ...deps, alvos: async () => [] };
  const r1 = await iniciarFaxinaSobDemanda(SLUG, { telegram: false }, semAlvo);
  assert.equal(r1.iniciado, false);
  assert.equal(r1.status, 422);
  assert.match(r1.motivo ?? '', /sem credencial do Kommo/);

  const r3 = await iniciarFaxinaSobDemanda(SLUG, { telegram: false }, { ...deps, alvos: async () => { throw new Error('banco fora'); } });
  assert.deepEqual([r3.iniciado, r3.status], [false, 503], 'erro de infraestrutura não é 409');

  const r2 = await iniciarFaxinaSobDemanda(SLUG, { telegram: false }, { ...deps, lider: () => false });
  assert.deepEqual([r2.iniciado, r2.status], [false, 409]);

  const ok = await iniciarFaxinaSobDemanda(SLUG, { telegram: false }, deps);
  assert.deepEqual([ok.iniciado, ok.modo], [true, 'seco']);
  const ocupado = await iniciarFaxinaSobDemanda(SLUG, { telegram: false }, deps);
  assert.deepEqual([ocupado.iniciado, ocupado.status], [false, 409]);
  await new Promise((r) => setTimeout(r, 50)); // a rodada falsa termina e libera
  const denovo = await iniciarFaxinaSobDemanda(SLUG, { telegram: false }, deps);
  assert.equal(denovo.iniciado, true);
  await new Promise((r) => setTimeout(r, 50));
});
