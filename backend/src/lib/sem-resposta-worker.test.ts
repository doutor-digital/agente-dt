import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  ESPERA_MS,
  JANELA_MS,
  REALERTA_MS,
  _esquecerConferidas,
  mesmaEsperaJaAlertada,
  deveAlertar,
  esperaDoPaciente,
  estadoDoAlertaSemResposta,
  soAgradecimento,
  textoDoAlerta,
  verificarUnidadeSemResposta,
  type DepsSemResposta,
} from './sem-resposta-worker.js';
import { _semearParaTeste } from './automacoes-estado.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
import type { Simulacao } from './so-no-papel.js';

/**
 * Decisão do João (16/10/2026): mensagem do paciente sem resposta por 5 minutos → alerta no Telegram dele.
 * Piloto Açailândia, chave alerta-sem-resposta. "Resposta" = qualquer mensagem que saiu para o paciente depois
 * da dele (equipe, Sofia ou robô): alerta só quando ninguém respondeu nada.
 */

const SLUG = 'doutor-hernia-acailandia';
const unidade = { id: 'u1', slug: SLUG, name: 'Açailândia', kommoSubdomain: 'doutorherniaacailandia', kommoAccessToken: 'x' } as Unit;
const T0 = new Date('2026-10-16T13:00:00Z'); // 10:00 em Açailândia

const msg = (direcao: 'entrada' | 'saida', em: Date, texto = 'oi'): MensagemOficial => ({
  id: `${direcao}-${em.getTime()}`,
  em,
  direcao,
  autor: direcao === 'entrada' ? 'paciente' : 'equipe',
  autorNome: '',
  texto,
  anexo: null,
  status: null,
});
const depois = (ms: number) => new Date(T0.getTime() + ms);

function cenario(opts: { oficiais: MensagemOficial[] | null; agora: Date; horario?: boolean; envia?: boolean }) {
  const r = { enviados: [] as string[], marcas: new Map<number, Date>(), simulados: [] as Simulacao[], leiturasOficiais: 0 };
  let agora = opts.agora;
  let oficiais = opts.oficiais;
  const deps: DepsSemResposta = {
    agora: () => agora,
    dentroDoHorario: () => opts.horario ?? true,
    candidatas: async () => [{ leadId: 28691582, contactName: 'Maria Silva', ultimaDoPacienteEm: T0 }],
    oficiais: async () => {
      r.leiturasOficiais++;
      return oficiais;
    },
    alertadoEm: async (_u, leadId) => r.marcas.get(leadId) ?? null,
    marcarAlertado: async (_u, leadId, quando) => {
      r.marcas.set(leadId, quando);
    },
    etapa: async () => 'EM TRATAMENTO',
    enviar: async (texto) => {
      if (opts.envia === false) return false;
      r.enviados.push(texto);
      return true;
    },
    simular: (_u, _a, s) => {
      r.simulados.push(s);
    },
  };
  return {
    deps,
    r,
    mudarAgora: (d: Date) => {
      agora = d;
    },
    mudarOficiais: (m: MensagemOficial[]) => {
      oficiais = m;
    },
  };
}

beforeEach(() => {
  _semearParaTeste([]);
  _esquecerConferidas();
});

test('esperaDoPaciente: conta da PRIMEIRA mensagem dele depois da última que saiu', () => {
  const m = [msg('entrada', T0), msg('saida', depois(60_000)), msg('entrada', depois(120_000), 'a'), msg('entrada', depois(180_000), 'b')];
  const e = esperaDoPaciente(m);
  assert.equal(e?.desde.getTime(), depois(120_000).getTime());
  assert.equal(e?.ultimaEm.getTime(), depois(180_000).getTime());
  assert.equal(e?.ultimaTexto, 'b');
  assert.equal(esperaDoPaciente([msg('entrada', T0), msg('saida', depois(30_000))]), null, 'respondido: a última fala foi para ele');
  assert.equal(esperaDoPaciente([]), null);
});

test('deveAlertar: 5 min sim, 4min59 não; mensagem da última hora; espera que começou ontem ainda vale se ele escreveu agora', () => {
  assert.equal(deveAlertar({ desde: T0, ultimaEm: T0 }, depois(ESPERA_MS - 1000)), false);
  assert.equal(deveAlertar({ desde: T0, ultimaEm: T0 }, depois(ESPERA_MS)), true);
  assert.equal(deveAlertar({ desde: T0, ultimaEm: T0 }, depois(ESPERA_MS + JANELA_MS + 60_000)), false, 'volta de queda não vira rajada');
  const ontem = new Date(T0.getTime() - 14 * 3600_000);
  assert.equal(deveAlertar({ desde: ontem, ultimaEm: T0 }, depois(60_000)), true, 'escreveu com a clínica fechada e de novo de manhã');
});

test('alerta depois de 5 min e NÃO antes', async () => {
  const c = cenario({ oficiais: [msg('saida', new Date(T0.getTime() - 3600_000)), msg('entrada', T0, 'Confirmar presença')], agora: depois(4 * 60_000) });
  const antes = await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(antes.alertas, 0);
  assert.equal(c.r.enviados.length, 0);

  c.mudarAgora(depois(5 * 60_000 + 1000));
  const agora = await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(agora.alertas, 1);
  assert.equal(c.r.enviados.length, 1);
  const t = c.r.enviados[0];
  assert.match(t, /^⏰ Paciente sem resposta há 5 min — Açailândia/);
  assert.match(t, /Contato: Maria Silva \(lead 28691582\)/);
  assert.match(t, /Etapa: EM TRATAMENTO/);
  assert.match(t, /Última mensagem: "Confirmar presença"/);
  assert.match(t, /https:\/\/doutorherniaacailandia\.kommo\.com\/leads\/detail\/28691582/);
});

test('idempotência: a mesma espera alerta UMA vez; resposta e nova espera alertam de novo', async () => {
  const c = cenario({ oficiais: [msg('entrada', T0)], agora: depois(6 * 60_000) });
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  c.mudarAgora(depois(7 * 60_000));
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  _esquecerConferidas(); // mesmo depois de um reinício (o cache em memória some), a marca do banco segura
  c.mudarAgora(depois(20 * 60_000));
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(c.r.enviados.length, 1);

  // alguém respondeu, e o paciente voltou a esperar: é outra espera
  c.mudarOficiais([msg('entrada', T0), msg('saida', depois(21 * 60_000)), msg('entrada', depois(22 * 60_000))]);
  c.mudarAgora(depois(28 * 60_000));
  _esquecerConferidas();
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(c.r.enviados.length, 2);
});

// Revisão de 16/10, item 6: a conversa oficial só traz as últimas mensagens. Quem manda mais do que isso (lote
// de fotos de exame) mudava o início da espera a cada mensagem, e cada mudança virava um alerta novo.
const rajada = (de: number, ate: number) => {
  const m: MensagemOficial[] = [];
  for (let i = de; i <= ate; i++) m.push(msg('entrada', depois(i * 60_000), `foto ${i}`));
  return m;
};

test('mesmaEsperaJaAlertada: alerta sem nada saído depois, há menos de 12 h', () => {
  const alerta = depois(6 * 60_000);
  const agora = depois(30 * 60_000);
  assert.equal(mesmaEsperaJaAlertada(rajada(0, 25), null, agora), false, 'nunca alertado');
  assert.equal(mesmaEsperaJaAlertada(rajada(0, 25), alerta, agora), true);
  assert.equal(mesmaEsperaJaAlertada([...rajada(0, 25), msg('saida', depois(10 * 60_000))], alerta, agora), false, 'alguém respondeu depois do alerta');
  assert.equal(mesmaEsperaJaAlertada([msg('saida', depois(2 * 60_000)), ...rajada(3, 25)], alerta, agora), true, 'resposta ANTES do alerta não conta');
  assert.equal(mesmaEsperaJaAlertada(rajada(0, 25), alerta, new Date(alerta.getTime() + REALERTA_MS)), false, '12 h depois: lembra de novo');
});

test('paciente que escreve sem parar (mais do que a conversa lida): UM alerta, não um por mensagem', async () => {
  const c = cenario({ oficiais: rajada(0, 2), agora: depois(6 * 60_000) });
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(c.r.enviados.length, 1);

  // 40 min depois, a janela lida já não mostra as primeiras: o "início da espera" visto mudou.
  for (const minuto of [20, 30, 45]) {
    c.mudarOficiais(rajada(minuto - 15, minuto));
    c.mudarAgora(depois((minuto + 1) * 60_000));
    _esquecerConferidas(); // mensagem nova = chave nova no cache em memória
    await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  }
  assert.equal(c.r.enviados.length, 1);

  // Ninguém respondeu e ele voltou a escrever 13 h depois: um lembrete novo.
  const tarde = 13 * 60;
  c.mudarOficiais(rajada(tarde - 2, tarde));
  c.mudarAgora(depois((tarde + 6) * 60_000));
  _esquecerConferidas();
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(c.r.enviados.length, 2);
});

test('só no papel também mostra UM "alertaria" por espera, não um por mensagem — e não grava marca', async () => {
  const c = cenario({ oficiais: rajada(0, 2), agora: depois(6 * 60_000) });
  await verificarUnidadeSemResposta(unidade, 'seco', c.deps);
  c.mudarOficiais(rajada(10, 25));
  c.mudarAgora(depois(26 * 60_000));
  // simula a mensagem nova sem apagar o que o seco lembra: a chave do cache muda com a última mensagem
  c.deps.candidatas = async () => [{ leadId: 28691582, contactName: 'Maria Silva', ultimaDoPacienteEm: depois(25 * 60_000) }];
  await verificarUnidadeSemResposta(unidade, 'seco', c.deps);
  assert.equal(c.r.simulados.length, 1);
  assert.equal(c.r.marcas.size, 0);
  assert.equal(c.r.enviados.length, 0);
});

test('respondido (equipe, Sofia ou robô) não alerta', async () => {
  const c = cenario({ oficiais: [msg('entrada', T0), msg('saida', depois(2 * 60_000), 'Oi Maria!')], agora: depois(10 * 60_000) });
  const r = await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(r.respondidas, 1);
  assert.equal(c.r.enviados.length, 0);
  // e não relê a conversa oficial a cada minuto
  c.mudarAgora(depois(11 * 60_000));
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(c.r.leiturasOficiais, 1);
});

test('só agradecimento ("Obrigada 🙏", "ok", "👍") não pede resposta — sem alerta; cumprimento, sim/não e áudio pedem', async () => {
  assert.equal(soAgradecimento(['Obrigada 🙏']), true);
  assert.equal(soAgradecimento(['ok', '👍']), true);
  assert.equal(soAgradecimento(['Bom dia']), false);
  assert.equal(soAgradecimento(['Sim']), false);
  assert.equal(soAgradecimento(['obrigada', 'qual o endereço?']), false);
  assert.equal(soAgradecimento(['']), false, 'áudio/imagem sem texto pede resposta');
  const c = cenario({ oficiais: [msg('saida', new Date(T0.getTime() - 60_000)), msg('entrada', T0, 'Obrigada 🙏')], agora: depois(10 * 60_000) });
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(c.r.enviados.length, 0);
});

test('sem conseguir ler a conversa oficial: não alerta no escuro', async () => {
  const c = cenario({ oficiais: null, agora: depois(10 * 60_000) });
  const r = await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(r.alertas, 0);
  assert.equal(c.r.enviados.length, 0);
});

test('Telegram recusou: não marca, e tenta de novo na próxima varredura', async () => {
  const c = cenario({ oficiais: [msg('entrada', T0)], agora: depois(6 * 60_000), envia: false });
  await verificarUnidadeSemResposta(unidade, 'ligado', c.deps);
  assert.equal(c.r.marcas.size, 0);
});

test('fora do horário da unidade e chave desligada: nada', async () => {
  const fora = cenario({ oficiais: [msg('entrada', T0)], agora: depois(10 * 60_000), horario: false });
  await verificarUnidadeSemResposta(unidade, 'ligado', fora.deps);
  assert.equal(fora.r.leiturasOficiais, 0);
  const desligado = cenario({ oficiais: [msg('entrada', T0)], agora: depois(10 * 60_000) });
  await verificarUnidadeSemResposta(unidade, 'desligado', desligado.deps);
  assert.equal(desligado.r.leiturasOficiais, 0);
});

test('só no papel: registra "alertaria" na tela e não manda nada', async () => {
  const c = cenario({ oficiais: [msg('entrada', T0, 'Alguém aí?')], agora: depois(8 * 60_000) });
  const r = await verificarUnidadeSemResposta(unidade, 'seco', c.deps);
  assert.equal(r.simulados, 1);
  assert.equal(c.r.enviados.length, 0);
  assert.equal(c.r.simulados[0].acao, 'alertaria');
  assert.match(String(c.r.simulados[0].motivo), /Alguém aí\?/);
});

test('chave por unidade: piloto na Açailândia', () => {
  assert.equal(estadoDoAlertaSemResposta(SLUG, {} as NodeJS.ProcessEnv), 'desligado');
  assert.equal(estadoDoAlertaSemResposta(SLUG, { ALERTA_SEM_RESPOSTA_SLUGS: SLUG } as NodeJS.ProcessEnv), 'ligado');
  assert.equal(estadoDoAlertaSemResposta('doutor-hernia-serra', { ALERTA_SEM_RESPOSTA_SLUGS: SLUG } as NodeJS.ProcessEnv), 'desligado');
});

test('texto do alerta: telefone na mensagem do paciente é mascarado; mídia sem texto é dita', () => {
  const t = textoDoAlerta({ unidade: 'Açailândia', contato: null, leadId: 1, etapa: null, esperaMs: 7 * 60_000, ultima: 'me liga no 99 99102-1043', link: null });
  assert.doesNotMatch(t, /99102-1043/);
  assert.match(t, /Contato: paciente \(lead 1\)/);
  assert.match(textoDoAlerta({ unidade: 'X', contato: 'A', leadId: 1, etapa: null, esperaMs: ESPERA_MS, ultima: '', link: null }), /sem texto/);
});
