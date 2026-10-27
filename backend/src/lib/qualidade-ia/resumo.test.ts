import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estaNaHora, modoDoResumo, paraLog, resolverODia, valorReconhecido, TENTATIVAS_POR_DIA, type Dependencias, type ResultadoDoLease } from './resumo.js';
import { diaDaSemana, inicioDoDia, relogioLocal, rotuloDoDia, somarDias } from './dias.js';
import type { DadosDiarios, DadosSemanais } from './tipos.js';

const SEGUNDA = '2026-10-26';
const SABADO = '2026-10-31';

/** Com alerta (juiz quase parado) e pior conversa, para provar o que NÃO pode ir para o log. */
const diario = (hoje: string): DadosDiarios => {
  const ontem = somarDias(hoje, -1);
  const dias = Array.from({ length: 8 }, (_, i) => somarDias(ontem, i - 7));
  return {
    dia: ontem,
    avaliacoes: dias.map((dia) => ({ dia, total: dia === ontem ? 20 : 230, semSofia: 0, sumiu: 0, avaliaveis: dia === ontem ? 20 : 100, mediaAvaliaveis: 6 })),
    mensagens: [],
    piores: [],
    pior: { nota: 2, unidade: 'Serra', primeiroNome: 'Maria', final4: '8888', leadId: '123456', trecho: ['Paciente: oi', 'Sofia: Vou acolher'] },
  };
};
const semanal = (hoje: string): DadosSemanais => ({ fim: somarDias(hoje, -1), avaliacoes: [], mensagens: [], faixas: [], piores: [] });

function fabrica(o: { lease?: ResultadoDoLease; telegram?: boolean; configurado?: boolean; coletaFalha?: boolean } = {}) {
  const enviados: string[] = [];
  const logs: Array<{ nivel: string; mensagem: string; dados: Record<string, unknown> }> = [];
  const leases: string[] = [];
  const liberados: string[] = [];
  let coletas = 0;
  const dep: Dependencias = {
    coletarDiario: async (h) => {
      coletas += 1;
      if (o.coletaFalha) throw new Error('banco fora');
      return diario(h);
    },
    coletarSemanal: async (h) => semanal(h),
    enviar: async (t) => {
      enviados.push(t);
      return o.telegram ?? true;
    },
    telegramConfigurado: () => o.configurado ?? true,
    reivindicar: async (nome) => {
      leases.push(nome);
      return o.lease ?? 'minha';
    },
    liberar: async (nome) => void liberados.push(nome),
    registrar: (nivel, dados, mensagem) => void logs.push({ nivel, mensagem, dados }),
  };
  return { dep, enviados, logs, leases, liberados, coletas: () => coletas };
}

test('modo: vazio = seco (nasce no papel); só "ligado" envia; "desligado" para tudo', () => {
  assert.equal(modoDoResumo(undefined), 'seco');
  assert.equal(modoDoResumo(''), 'seco');
  assert.equal(modoDoResumo('seco'), 'seco');
  assert.equal(modoDoResumo('LIGADO'), 'ligado');
  assert.equal(modoDoResumo('"ligado"'), 'ligado');
  assert.equal(modoDoResumo('desligado'), 'desligado');
  assert.equal(modoDoResumo('qualquer coisa'), 'seco', 'valor estranho nunca liga o envio');
});

test('janela: 07:30 a 12:00 de São Paulo, uma vez por dia', () => {
  const sp = (hhmm: string, dia = SEGUNDA) => new Date(`${dia}T${hhmm}:00-03:00`);
  assert.equal(estaNaHora(sp('07:29'), null).rodar, false);
  assert.equal(estaNaHora(sp('07:30'), null).rodar, true);
  assert.equal(estaNaHora(sp('11:59'), null).rodar, true);
  assert.equal(estaNaHora(sp('12:00'), null).rodar, false, 'resumo da manhã não sai à tarde');
  assert.equal(estaNaHora(sp('08:00'), SEGUNDA).rodar, false, 'já resolvido hoje');
  assert.equal(estaNaHora(sp('08:00'), '2026-10-25').rodar, true);
  // 07:30 em Brasília é 10:30 UTC: o dia certo é o de São Paulo, não o do servidor
  assert.equal(estaNaHora(new Date(`${SEGUNDA}T10:30:00Z`), null).hoje, SEGUNDA);
  assert.equal(estaNaHora(new Date(`${SEGUNDA}T02:00:00Z`), null).hoje, '2026-10-25', '23h de domingo ainda é domingo');
});

test('datas: dia da semana, rótulo, fuso fixo −03:00 e meia-noite sem "24"', () => {
  assert.equal(diaDaSemana(SEGUNDA), 1);
  assert.equal(diaDaSemana(SABADO), 6);
  assert.equal(rotuloDoDia(SEGUNDA), '26/10 (seg)');
  assert.equal(inicioDoDia(SEGUNDA).toISOString(), '2026-10-26T03:00:00.000Z');
  assert.equal(somarDias('2026-10-31', 1), '2026-11-01');
  assert.deepEqual(relogioLocal(new Date('2026-10-26T03:00:00Z')), { hora: 0, minuto: 0, diaDaSemana: 1 });
});

test('valor desconhecido da variável é reconhecido como tal (cai em seco e o worker avisa)', () => {
  assert.equal(valorReconhecido(undefined), true);
  assert.equal(valorReconhecido('ligado'), true);
  assert.equal(valorReconhecido('"seco"'), true);
  assert.equal(valorReconhecido('ligada'), false);
  assert.equal(valorReconhecido('on'), false);
  assert.equal(modoDoResumo('ligada'), 'seco');
});

test('o log não guarda NENHUM dado de paciente: nem fala, nem 1º nome, nem final do telefone, nem cartão', () => {
  const texto = [
    'Sofia, resumo de 26/10 (seg): piorou',
    'Juiz: 60 avaliadas',
    'Pior conversa avaliável: nota 2,4, Serra (Maria, final 8888, cartão 123456)',
    '  Paciente: meu e-mail é a@b.com',
    '  Sofia: Vou acolher',
  ].join('\n');
  const log = paraLog(texto);
  assert.doesNotMatch(log, /Maria|8888|123456|e-mail|Vou acolher|Paciente:/);
  assert.match(log, /Juiz: 60 avaliadas/, 'os números continuam no log');
  assert.equal(paraLog('Sofia, resumo\nJuiz: 1'), 'Sofia, resumo\nJuiz: 1', 'sem pior conversa, nada a tirar');
});

test('ligado, segunda: manda 1 mensagem (diário) e pega o lease do dia', async () => {
  const f = fabrica();
  const r = await resolverODia(SEGUNDA, 'ligado', f.dep);
  assert.equal(r, 'enviado');
  assert.equal(f.enviados.length, 1);
  assert.match(f.enviados[0], /Sofia, resumo de 25\/10 \(dom\)/);
  assert.deepEqual(f.leases, [`resumo-diario-ia:${SEGUNDA}:diario`]);
});

test('ligado, sábado: o diário E o semanal', async () => {
  const f = fabrica();
  assert.equal(await resolverODia(SABADO, 'ligado', f.dep), 'enviado');
  assert.equal(f.enviados.length, 2);
  assert.match(f.enviados[0], /resumo de 30\/10/);
  assert.match(f.enviados[1], /Sofia, semana de 24\/10 \(sáb\) a 30\/10 \(sex\)/);
});

test('SECO não envia nada: só registra o texto que mandaria (o portão cobre o diário e o semanal)', async () => {
  const f = fabrica();
  assert.equal(await resolverODia(SABADO, 'seco', f.dep), 'seco');
  assert.deepEqual(f.enviados, []);
  const secos = f.logs.filter((l) => /\[seco\]/.test(l.mensagem));
  assert.equal(secos.length, 2);
  assert.deepEqual(f.leases, [], 'seco não grava lease: trancaria o 1º dia depois de ligar');
  assert.match(String(secos[0].dados.texto), /Sofia, resumo de 30\/10/);
  for (const l of f.logs) assert.doesNotMatch(JSON.stringify(l), /Maria|8888|123456/, 'nenhum registro do seco leva dado de paciente');
  assert.match(String(secos[1].dados.texto), /semana de 24\/10/);
});

test('desligado não consulta o banco nem pega lease', async () => {
  const f = fabrica();
  assert.equal(await resolverODia(SEGUNDA, 'desligado', f.dep), 'desligado');
  assert.equal(f.coletas(), 0);
  assert.deepEqual(f.leases, []);
});

test('lease de outro processo: não monta nem envia (duas réplicas = uma mensagem) e avisa em warn', async () => {
  const f = fabrica({ lease: 'de-outro' });
  assert.equal(await resolverODia(SEGUNDA, 'ligado', f.dep), 'de-outro-processo');
  assert.ok(f.logs.some((l) => l.nivel === 'warn' && /lease do dia é de outro processo/.test(l.mensagem)));
  assert.equal(f.coletas(), 0);
  assert.deepEqual(f.enviados, []);
});

test('banco do lease com erro: não envia sem lease, tenta no próximo passo', async () => {
  const f = fabrica({ lease: 'erro' });
  assert.equal(await resolverODia(SEGUNDA, 'ligado', f.dep), 'sem-lease');
  assert.deepEqual(f.enviados, []);
});

test('ligado sem token do Telegram: avisa no log como erro e não tenta enviar', async () => {
  const f = fabrica({ configurado: false });
  assert.equal(await resolverODia(SEGUNDA, 'ligado', f.dep), 'sem-telegram');
  assert.deepEqual(f.enviados, []);
  assert.deepEqual(f.leases, [], 'sem token não pega lease: corrigir o token e reiniciar no mesmo dia ainda envia');
  assert.ok(f.logs.some((l) => l.nivel === 'error' && /TELEGRAM_BOT_TOKEN/.test(l.mensagem)));
});

test('Telegram recusa: solta o lease e tenta de novo; depois das tentativas desiste', async () => {
  const f = fabrica({ telegram: false });
  const enviados = new Set<'diario' | 'semanal'>();
  assert.equal(await resolverODia(SEGUNDA, 'ligado', f.dep, 1, enviados), 'tentar-de-novo');
  assert.deepEqual(f.liberados, [`resumo-diario-ia:${SEGUNDA}:diario`]);
  assert.equal(await resolverODia(SEGUNDA, 'ligado', f.dep, TENTATIVAS_POR_DIA, enviados), 'desistiu');
});

test('consulta falha: nunca lança, solta o lease para a próxima tentativa', async () => {
  const f = fabrica({ coletaFalha: true });
  assert.equal(await resolverODia(SEGUNDA, 'ligado', f.dep), 'tentar-de-novo');
  assert.deepEqual(f.enviados, []);
  assert.equal(f.liberados.length, 1);
  assert.equal(await resolverODia(SEGUNDA, 'seco', fabrica({ coletaFalha: true }).dep), 'tentar-de-novo', 'seco também não lança');
  assert.ok(f.logs.some((l) => l.nivel === 'error' && /falhou ao montar/.test(l.mensagem)));
});

test('sábado: se o diário saiu e o semanal falhou, a nova tentativa não repete o diário', async () => {
  let chamadas = 0;
  const f = fabrica();
  f.dep.enviar = async (t) => {
    chamadas += 1;
    f.enviados.push(t);
    return chamadas !== 2; // o 2º envio (semanal) falha
  };
  const ja = new Set<'diario' | 'semanal'>();
  assert.equal(await resolverODia(SABADO, 'ligado', f.dep, 1, ja), 'tentar-de-novo');
  assert.deepEqual([...ja], ['diario']);
  assert.deepEqual(f.liberados, [`resumo-diario-ia:${SABADO}:semanal`], 'só o lease do semanal (que falhou) é solto; o do diário fica');
  assert.equal(await resolverODia(SABADO, 'ligado', f.dep, 2, ja), 'enviado');
  assert.equal(f.enviados.length, 3);
  assert.match(f.enviados[2], /semana de/);
});
