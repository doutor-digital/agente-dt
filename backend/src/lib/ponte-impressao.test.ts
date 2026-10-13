import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  casarPorImpressoes,
  impressaoDaMensagem,
  impressoesValidas,
  minutoNoFuso,
  minutosDaMensagemGuardada,
  normalizarParaImpressao,
} from './ponte-impressao.js';

// O CONTRATO com a extensão: os vetores fixos (calculados fora, em Python) e o próprio `impressao.js` dela.
const EXTENSAO = new URL('../../../extensao-ponte/', import.meta.url);
const { vetores } = JSON.parse(readFileSync(new URL('testes/vetores-impressao.json', EXTENSAO), 'utf8')) as {
  vetores: Array<{ texto: string; minuto: string; normalizado: string; impressao: string | null }>;
};
const daExtensao = createRequire(import.meta.url)(new URL('impressao.js', EXTENSAO).pathname) as {
  normalizar(t: string): string;
  impressao(t: string, m: string): Promise<string | null>;
};

describe('impressão: servidor = vetores = extensão', () => {
  it('a normalização do servidor dá o mesmo texto dos vetores', () => {
    for (const v of vetores) assert.equal(normalizarParaImpressao(v.texto), v.normalizado, JSON.stringify(v.texto));
  });

  it('o hash do servidor dá o mesmo dos vetores (e null para vazio/minuto inválido)', () => {
    for (const v of vetores) assert.equal(impressaoDaMensagem(v.texto, v.minuto), v.impressao, `${JSON.stringify(v.texto)} ${v.minuto}`);
  });

  it('o hash da EXTENSÃO (impressao.js, crypto.subtle) é igual ao do servidor (node:crypto)', async () => {
    const extras = [
      'Olá! Gostaria de saber o valor da consulta 😊',
      'SIM', 'ok', 'Bom dia, Dra.', 'Árvore — ação; pão & café', 'tô com dor nas costas\nfaz 3 meses',
      '1️⃣', 'https://wa.me/5563991021043', 'Não posso amanhã às 8h, só depois das 14:30',
    ];
    const casos = [...vetores.map((v) => [v.texto, v.minuto] as const), ...extras.map((t) => [t, '08:15'] as const)];
    for (const [texto, minuto] of casos) {
      assert.equal(daExtensao.normalizar(texto), normalizarParaImpressao(texto), JSON.stringify(texto));
      assert.equal(await daExtensao.impressao(texto, minuto), impressaoDaMensagem(texto, minuto), JSON.stringify(texto));
    }
  });
});

describe('minutos', () => {
  it('HH:MM em São Paulo, 24 h', () => {
    assert.equal(minutoNoFuso(new Date('2026-10-13T13:05:59Z')), '10:05');
    assert.equal(minutoNoFuso(new Date('2026-10-14T03:00:00Z')), '00:00');
    assert.equal(minutoNoFuso(new Date('2026-10-14T02:59:00Z')), '23:59');
  });

  it('mensagem guardada vale no minuto gravado, nos 2 anteriores e no seguinte — dando a volta na meia-noite', () => {
    assert.deepEqual(minutosDaMensagemGuardada(new Date('2026-10-13T13:01:30Z')), ['09:59', '10:00', '10:01', '10:02']);
    assert.deepEqual(minutosDaMensagemGuardada(new Date('2026-10-14T03:00:30Z')), ['23:58', '23:59', '00:00', '00:01']);
    assert.deepEqual(minutosDaMensagemGuardada(new Date('2026-10-14T02:59:00Z')), ['23:57', '23:58', '23:59', '00:00']);
  });

  it('5.000 mensagens não travam o servidor (formatador reaproveitado)', () => {
    const msgs = Array.from({ length: 5_000 }, (_, i) => ({ leadId: String(i % 300), texto: `mensagem número ${i} do paciente`, em: new Date(Date.parse('2026-10-13T13:00:00Z') - i * 30_000) }));
    const t0 = performance.now();
    casarPorImpressoes([impressaoDaMensagem('nada a ver', '10:00')!, impressaoDaMensagem('outra', '10:01')!], msgs, new Date('2026-10-13T14:00:00Z'));
    const ms = performance.now() - t0;
    assert.ok(ms < 600, `levou ${Math.round(ms)} ms`);
  });
});

describe('impressoesValidas', () => {
  it('só hex de 64, sem repetição, até o máximo; aceita lista ou texto com vírgulas', () => {
    const h = 'a'.repeat(64);
    const g = 'B'.repeat(64);
    assert.deepEqual(impressoesValidas(`${h},${h}, ${g},xyz,${'c'.repeat(63)}`), [h, 'b'.repeat(64)]);
    assert.deepEqual(impressoesValidas([h, 42, null]), [h]);
    assert.deepEqual(impressoesValidas(undefined), []);
    assert.equal(impressoesValidas(Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(64, '0')), 8).length, 8);
  });
});

describe('casarPorImpressoes', () => {
  const AGORA = new Date('2026-10-13T14:00:00Z'); // 11:00 em São Paulo; o relógio do teste não depende do dia
  const casar = (impressoes: string[], msgs: Parameters<typeof casarPorImpressoes>[1]) => casarPorImpressoes(impressoes, msgs, AGORA);
  // o que o WhatsApp mostrou (hora em São Paulo) → o que a extensão manda
  const imp = (texto: string, minuto: string) => impressaoDaMensagem(texto, minuto)!;
  const em = (hhmm: string, seg = 20) => new Date(`2026-10-13T${String(Number(hhmm.slice(0, 2)) + 3).padStart(2, '0')}:${hhmm.slice(3)}:${String(seg).padStart(2, '0')}Z`);
  const guardadas = [
    { leadId: '111', texto: 'Oi', em: em('09:41') },
    { leadId: '111', texto: 'Quero marcar uma avaliação', em: em('09:59', 5) }, // o webhook chegou 1 min depois
    { leadId: '111', texto: 'R$ 250,00 no pix?', em: em('10:02') },
    { leadId: '222', texto: 'oi', em: em('09:41') },
    { leadId: '222', texto: 'Qual o endereço?', em: em('09:45') },
    { leadId: '333', texto: 'Bom dia', em: em('08:00') },
  ];

  it('acha a conversa com 2 impressões batendo — mesmo com o webhook 1 min atrasado e o texto da tela sem asterisco', () => {
    const r = casar([imp('*Quero* marcar uma avaliação 🙏', '09:58'), imp('R$ 250,00 no pix?', '10:02')], guardadas);
    assert.deepEqual(r, { leadId: '111', batidas: 2 });
  });

  it('com várias enviadas, só 1 batendo não basta', () => {
    assert.equal(casar([imp('R$ 250,00 no pix?', '10:02'), imp('outra coisa', '10:03'), imp('mais uma', '10:04')], guardadas), null);
  });

  it('se só uma foi enviada, uma basta — desde que aponte uma conversa só', () => {
    assert.deepEqual(casar([imp('Bom dia', '08:00')], guardadas), { leadId: '333', batidas: 1 });
    // "oi" às 09:41 veio de dois pacientes: ambíguo, não aponta ninguém
    assert.deepEqual(casar([imp('oi', '09:41')], guardadas), { ambiguo: true });
  });

  it('minuto errado não casa; nada enviado não casa', () => {
    assert.equal(casar([imp('Bom dia', '08:05')], guardadas), null);
    assert.equal(casar([], guardadas), null);
    assert.equal(casar(['lixo'], guardadas), null);
  });

  it('UMA impressão só não casa com mensagem de ONTEM no mesmo minuto (a impressão não tem data)', () => {
    const ontem = [{ leadId: '555', texto: 'Bom dia', em: new Date('2026-10-12T11:01:20Z') }]; // 08:01 de ontem
    assert.equal(casar([imp('bom dia', '08:01')], ontem), null);
    // com duas batendo na mesma conversa, as últimas 48 h valem
    const ontem2 = [...ontem, { leadId: '555', texto: 'quero agendar', em: new Date('2026-10-12T11:02:10Z') }];
    assert.deepEqual(casar([imp('bom dia', '08:01'), imp('quero agendar', '08:02')], ontem2), { leadId: '555', batidas: 2 });
    // e nada mais velho que 48 h
    const anteontem = ontem2.map((m) => ({ ...m, em: new Date(m.em.getTime() - 26 * 3_600_000) }));
    assert.equal(casar([imp('bom dia', '06:01'), imp('quero agendar', '06:02')], anteontem), null); // 06:01 de 11/10 — 50 h atrás
  });

  it('empate entre duas conversas com 2 batidas cada = ambíguo', () => {
    const dobradas = [...guardadas, { leadId: '444', texto: 'Quero marcar uma avaliação', em: em('09:58') }, { leadId: '444', texto: 'R$ 250,00 no pix?', em: em('10:02') }];
    const r = casar([imp('Quero marcar uma avaliação', '09:58'), imp('R$ 250,00 no pix?', '10:02')], dobradas);
    assert.deepEqual(r, { ambiguo: true });
  });
});
