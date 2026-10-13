import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRUPOS_DA_FILA,
  PRAZOS_DA_FILA,
  cartaoDaFila,
  diaEHora,
  epochDoValor,
  etapaDoSemResposta,
  montarGrupos,
  regraConfirmar,
  regraFaltou,
  regraNegociacao,
  regraRetomar,
  regraSemResposta,
  situacaoConfirmada,
  somarDias,
  telefoneParaMostrar,
  telefoneParaWhatsapp,
  type CandidatoDaFila,
  type CartaoDaFila,
  type PrazosDaFila,
} from './ponte-fila.js';

const TZ = 'America/Sao_Paulo';
// terça, 13/10/2026, 12:00 em São Paulo
const agora = new Date('2026-10-13T15:00:00Z');
const ep = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const H = 3600;
const D = 86_400;
const agoraEp = ep('2026-10-13T15:00:00Z');

function cartao(p: Partial<CartaoDaFila> = {}): CartaoDaFila {
  return {
    id: 1,
    nome: 'MARIA SOUZA 03/10/2026',
    etapa: 'AGENDADO',
    criadoEpoch: agoraEp - 30 * D,
    atualizadoEpoch: agoraEp - 10 * D,
    consultaEpoch: null,
    situacao: null,
    retomarEmEpoch: null,
    contatoId: 9,
    ...p,
  };
}

describe('fila — os prazos num lugar só', () => {
  it('os padrões pedidos: amanhã, 3 dias, 2 h; cache de 2 min', () => {
    assert.equal(PRAZOS_DA_FILA.confirmarDiasAntes, 1);
    assert.equal(PRAZOS_DA_FILA.negociacaoParadaDias, 3);
    assert.equal(PRAZOS_DA_FILA.semRespostaHoras, 2);
    assert.equal(PRAZOS_DA_FILA.cacheMs, 120_000);
    assert.equal(PRAZOS_DA_FILA.maxPorGrupo, 30);
    assert.ok(Object.isFrozen(PRAZOS_DA_FILA));
  });

  it('os grupos seguem a ordem do funil COMERCIAL', () => {
    assert.deepEqual(GRUPOS_DA_FILA.map((g) => g.etapa), ['EM QUALIFICAÇÃO', 'EM ESPERA', 'AGENDADO', 'NÃO COMPARECEU', 'EM NEGOCIAÇÃO']);
    assert.deepEqual(GRUPOS_DA_FILA.map((g) => g.rotulo), ['sem resposta', 'retomar contato', 'confirmar presença', 'faltou: remarcar', 'retomar negociação']);
  });
});

describe('fila — AGENDADO: confirmar presença', () => {
  it('consulta amanhã entra, com a hora de São Paulo', () => {
    const p = regraConfirmar(cartao({ consultaEpoch: ep('2026-10-14T11:00:00Z') }), agora, TZ);
    assert.deepEqual(p, { detalhe: 'consulta amanhã às 08:00', quando: ep('2026-10-14T11:00:00Z') });
  });

  it('o dia é o de São Paulo: 23h de amanhã (02h UTC do dia seguinte) ainda é amanhã', () => {
    assert.ok(regraConfirmar(cartao({ consultaEpoch: ep('2026-10-15T02:00:00Z') }), agora, TZ));
    assert.equal(regraConfirmar(cartao({ consultaEpoch: ep('2026-10-14T02:00:00Z') }), agora, TZ), null, '23h de HOJE não é amanhã');
  });

  it('hoje, depois de amanhã, sem data ou já confirmada não entra', () => {
    assert.equal(regraConfirmar(cartao({ consultaEpoch: ep('2026-10-13T20:00:00Z') }), agora, TZ), null);
    assert.equal(regraConfirmar(cartao({ consultaEpoch: ep('2026-10-15T11:00:00Z') }), agora, TZ), null);
    assert.equal(regraConfirmar(cartao(), agora, TZ), null);
    assert.equal(regraConfirmar(cartao({ consultaEpoch: ep('2026-10-14T11:00:00Z'), situacao: 'Confirmado' }), agora, TZ), null);
  });

  it('o prazo muda num lugar só: 2 dias antes', () => {
    const prazos: PrazosDaFila = { ...PRAZOS_DA_FILA, confirmarDiasAntes: 2 };
    const p = regraConfirmar(cartao({ consultaEpoch: ep('2026-10-15T11:00:00Z') }), agora, TZ, prazos);
    assert.equal(p?.detalhe, 'consulta 15/10 às 08:00');
  });

  it('campo só de data (meia-noite) não inventa hora', () => {
    assert.equal(regraConfirmar(cartao({ consultaEpoch: ep('2026-10-14T03:00:00Z') }), agora, TZ)?.detalhe, 'consulta amanhã');
  });

  it('situação confirmada, em qualquer grafia', () => {
    assert.equal(situacaoConfirmada('CONFIRMADO'), true);
    assert.equal(situacaoConfirmada('Confirmada pelo paciente'), true);
    assert.equal(situacaoConfirmada('Agendado'), false);
    assert.equal(situacaoConfirmada(null), false);
  });
});

describe('fila — NÃO COMPARECEU: faltou, remarcar', () => {
  it('falta com data', () => {
    assert.deepEqual(regraFaltou(cartao({ etapa: 'NÃO COMPARECEU', consultaEpoch: ep('2026-10-10T11:00:00Z') }), agora, TZ), {
      detalhe: 'faltou em 10/10',
      quando: ep('2026-10-10T11:00:00Z'),
    });
  });

  it('sem data no cartão: entra pela última mexida', () => {
    const c = cartao({ etapa: 'NÃO COMPARECEU', atualizadoEpoch: agoraEp - 2 * D });
    assert.deepEqual(regraFaltou(c, agora, TZ), { detalhe: 'faltou', quando: agoraEp - 2 * D });
  });

  it('já tem consulta nova no futuro (remarcou e o cartão não andou): não entra', () => {
    assert.equal(regraFaltou(cartao({ etapa: 'NÃO COMPARECEU', consultaEpoch: agoraEp + 2 * D }), agora, TZ), null);
  });
});

describe('fila — EM ESPERA: retomar contato', () => {
  it('"◷ Retomar em" hoje ou antes entra; depois de hoje não', () => {
    assert.equal(regraRetomar(cartao({ retomarEmEpoch: ep('2026-10-13T11:00:00Z') }), agora, TZ)?.detalhe, 'retomar hoje');
    assert.equal(regraRetomar(cartao({ retomarEmEpoch: ep('2026-10-10T11:00:00Z') }), agora, TZ)?.detalhe, 'retomar desde 10/10');
    assert.equal(regraRetomar(cartao({ retomarEmEpoch: ep('2026-10-14T11:00:00Z') }), agora, TZ), null);
  });

  it('22h de hoje em São Paulo (01h UTC de amanhã) é hoje', () => {
    assert.equal(regraRetomar(cartao({ retomarEmEpoch: ep('2026-10-14T01:00:00Z') }), agora, TZ)?.detalhe, 'retomar hoje');
  });

  it('sem data de retomada: a espera é da SDR, não entra', () => {
    assert.equal(regraRetomar(cartao(), agora, TZ), null);
  });
});

describe('fila — EM NEGOCIAÇÃO: parado há 3 dias (o mesmo "parado" do worker de parados)', () => {
  const sinais = (p: Partial<{ ultimaConversaEpoch: number | null; entrouNaEtapaNoPrazo: boolean | null }> = {}) => ({
    ultimaConversaEpoch: null,
    entrouNaEtapaNoPrazo: false,
    janelaDias: 7,
    ...p,
  });

  it('última conversa há 4 dias e sem mudança de etapa: entra, com o dia da conversa', () => {
    const p = regraNegociacao(cartao(), sinais({ ultimaConversaEpoch: agoraEp - 4 * D }), agora, TZ);
    assert.deepEqual(p, { detalhe: 'sem conversa desde 09/10', quando: agoraEp - 4 * D });
  });

  it('sem conversa na janela lida: entra sem "há quanto tempo" (não se sabe o dia)', () => {
    const p = regraNegociacao(cartao(), sinais(), agora, TZ);
    assert.equal(p?.detalhe, 'sem conversa há mais de 7 dias');
    assert.equal(p?.semTempo, true);
  });

  it('robô que grava campo NÃO tira o cartão da fila: o updated_at não conta quando há os eventos', () => {
    assert.ok(regraNegociacao(cartao({ atualizadoEpoch: agoraEp - 60 }), sinais(), agora, TZ));
  });

  it('conversa de ontem segura; entrar na etapa dentro do prazo segura; cartão novo segura', () => {
    assert.equal(regraNegociacao(cartao(), sinais({ ultimaConversaEpoch: agoraEp - 1 * D }), agora, TZ), null);
    assert.equal(regraNegociacao(cartao(), sinais({ entrouNaEtapaNoPrazo: true }), agora, TZ), null);
    assert.equal(regraNegociacao(cartao({ criadoEpoch: agoraEp - 2 * D }), sinais(), agora, TZ), null);
  });

  it('sem os eventos do Kommo, o updated_at do cartão faz as vezes', () => {
    assert.equal(regraNegociacao(cartao({ atualizadoEpoch: agoraEp - 1 * D }), sinais({ entrouNaEtapaNoPrazo: null }), agora, TZ), null);
    assert.ok(regraNegociacao(cartao({ atualizadoEpoch: agoraEp - 5 * D }), sinais({ entrouNaEtapaNoPrazo: null }), agora, TZ));
  });

  it('o limite: conversa há 3 dias exatos entra, 3 dias menos 1 min não', () => {
    assert.ok(regraNegociacao(cartao(), sinais({ ultimaConversaEpoch: agoraEp - 3 * D }), agora, TZ));
    assert.equal(regraNegociacao(cartao(), sinais({ ultimaConversaEpoch: agoraEp - 3 * D + 60 }), agora, TZ), null);
  });

  it('o prazo muda num lugar só', () => {
    const prazos: PrazosDaFila = { ...PRAZOS_DA_FILA, negociacaoParadaDias: 7 };
    assert.equal(regraNegociacao(cartao(), sinais({ ultimaConversaEpoch: agoraEp - 4 * D }), agora, TZ, prazos), null);
  });
});

describe('fila — entrada / EM QUALIFICAÇÃO: sem resposta', () => {
  const conv = (p: Partial<{ lida: boolean; aberta: boolean; atualizadaEpoch: number }> = {}) => ({
    lida: false,
    aberta: true,
    atualizadaEpoch: agoraEp - 3 * H,
    ...p,
  });

  it('não lida há 3 h entra, com a hora em que escreveu', () => {
    assert.deepEqual(regraSemResposta(conv(), null, agora, TZ), { detalhe: 'escreveu às 09:00', quando: agoraEp - 3 * H });
  });

  it('de ontem diz o dia', () => {
    assert.equal(regraSemResposta(conv({ atualizadaEpoch: agoraEp - 26 * H }), null, agora, TZ)?.detalhe, 'escreveu em 12/10 às 10:00');
  });

  it('lida, concluída ou há menos de 2 h: não entra', () => {
    assert.equal(regraSemResposta(conv({ lida: true }), null, agora, TZ), null);
    assert.equal(regraSemResposta(conv({ aberta: false }), null, agora, TZ), null);
    assert.equal(regraSemResposta(conv({ atualizadaEpoch: agoraEp - 2 * H + 60 }), null, agora, TZ), null);
    assert.ok(regraSemResposta(conv({ atualizadaEpoch: agoraEp - 2 * H }), null, agora, TZ), '2 h exatas entram');
  });

  it('a Sofia respondeu (fala dela junto da última mexida): não é "sem resposta"', () => {
    assert.equal(regraSemResposta(conv(), agoraEp - 3 * H - 120, agora, TZ), null, 'a entrega no Kommo chega depois da fala gravada');
    assert.ok(regraSemResposta(conv(), agoraEp - 3 * H - 3600, agora, TZ), 'fala da Sofia de 1 h antes: o paciente escreveu depois');
  });

  it('o prazo de horas muda num lugar só', () => {
    const prazos: PrazosDaFila = { ...PRAZOS_DA_FILA, semRespostaHoras: 4 };
    assert.equal(regraSemResposta(conv(), null, agora, TZ, prazos), null);
  });

  it('as etapas do grupo: entrada (nome ou tipo 1) e EM QUALIFICAÇÃO', () => {
    assert.equal(etapaDoSemResposta('Etapa de leads de entrada'), true);
    assert.equal(etapaDoSemResposta('Leads de entrada'), true);
    assert.equal(etapaDoSemResposta('Qualquer nome', 1), true);
    assert.equal(etapaDoSemResposta('EM QUALIFICAÇÃO'), true);
    assert.equal(etapaDoSemResposta('Em qualificacao'), true);
    assert.equal(etapaDoSemResposta('AGENDADO'), false);
    assert.equal(etapaDoSemResposta(null), false);
  });
});

describe('fila — o cartão do Kommo lido pelo nome dos campos', () => {
  it('datas em segundos, ms ou ISO; contato principal', () => {
    const c = cartaoDaFila(
      {
        id: 7,
        name: '  JOANA PRADO 01/10/2026 ',
        created_at: 100,
        updated_at: 200,
        custom_fields_values: [
          { field_name: '◷ Data da Consulta', values: [{ value: 1_792_000_000 }] },
          { field_name: '✓ Situação da consulta', values: [{ value: 'Agendado' }] },
          { field_name: '◷ Retomar em', values: [{ value: 1_792_000_000_000 }] },
        ],
        _embedded: { contacts: [{ id: 5 }, { id: 6, is_main: true }] },
      },
      'AGENDADO',
    );
    assert.deepEqual(c, {
      id: 7,
      nome: 'JOANA PRADO 01/10/2026',
      etapa: 'AGENDADO',
      criadoEpoch: 100,
      atualizadoEpoch: 200,
      consultaEpoch: 1_792_000_000,
      situacao: 'Agendado',
      retomarEmEpoch: 1_792_000_000,
      contatoId: 6,
    });
  });

  it('epochDoValor: vazio, lixo e data brasileira viram null', () => {
    assert.equal(epochDoValor(''), null);
    assert.equal(epochDoValor(null), null);
    assert.equal(epochDoValor('05/10/2026'), null);
    assert.equal(epochDoValor(true), null);
    assert.equal(epochDoValor('2026-10-14T11:00:00Z'), ep('2026-10-14T11:00:00Z'));
  });

  it('datas: somar dias atravessa o mês; dia e hora no fuso', () => {
    assert.equal(somarDias('2026-10-31', 1), '2026-11-01');
    assert.equal(somarDias('2026-12-31', 1), '2027-01-01');
    assert.equal(diaEHora(ep('2026-10-14T11:00:00Z'), TZ), '14/10 às 08:00');
    assert.equal(diaEHora(ep('2026-10-14T11:00:00Z'), 'America/Boa_Vista'), '14/10 às 07:00');
  });
});

describe('fila — telefone para "Abrir conversa" e "Copiar telefone"', () => {
  it('vira dígitos com o país', () => {
    assert.equal(telefoneParaWhatsapp('+55 (63) 99102-1043'), '5563991021043');
    assert.equal(telefoneParaWhatsapp('63991021043'), '5563991021043');
    assert.equal(telefoneParaWhatsapp('(63) 9102-1043'), '556391021043');
    assert.equal(telefoneParaWhatsapp('063991021043'), '5563991021043', 'zero de discagem sai');
    assert.equal(telefoneParaWhatsapp('5563991021043'), '5563991021043');
    assert.equal(telefoneParaWhatsapp('+1 415 555 2671'), '14155552671', 'de fora do Brasil fica como está');
  });

  it('o que não é telefone fica de fora (inclusive o JID @lid)', () => {
    for (const ruim of ['', null, undefined, 'Maria', '12345', '204567890123456@lid', '1234567890123456']) {
      assert.equal(telefoneParaWhatsapp(ruim), null, String(ruim));
    }
  });

  it('para mostrar e copiar', () => {
    assert.equal(telefoneParaMostrar('5563991021043'), '(63) 99102-1043');
    assert.equal(telefoneParaMostrar('556391021043'), '(63) 9102-1043');
    assert.equal(telefoneParaMostrar('14155552671'), '+14155552671');
  });
});

describe('fila — os grupos', () => {
  const cand = (grupo: CandidatoDaFila['grupo'], id: number, quando: number): CandidatoDaFila => ({
    grupo,
    cartao: cartao({ id }),
    pista: { detalhe: '', quando },
  });

  it('ordem do funil; "antigo" = quem espera há mais tempo primeiro; "recente" = o mais quente primeiro', () => {
    const g = montarGrupos([
      cand('negociacao', 1, 100),
      cand('negociacao', 2, 300),
      cand('sem-resposta', 3, 300),
      cand('sem-resposta', 4, 100),
      cand('confirmar', 5, 50),
    ]);
    assert.deepEqual(g.map((x) => x.def.id), ['sem-resposta', 'retomar', 'confirmar', 'faltou', 'negociacao']);
    assert.deepEqual(g[0].itens.map((i) => i.cartao.id), [4, 3]);
    assert.deepEqual(g[4].itens.map((i) => i.cartao.id), [2, 1]);
    assert.equal(g[1].total, 0);
  });

  it('corta em maxPorGrupo e mantém o total', () => {
    const muitos = Array.from({ length: 45 }, (_, i) => cand('faltou', i + 1, i));
    const g = montarGrupos(muitos, { ...PRAZOS_DA_FILA, maxPorGrupo: 30 }).find((x) => x.def.id === 'faltou')!;
    assert.equal(g.total, 45);
    assert.equal(g.itens.length, 30);
    assert.equal(g.itens[0].cartao.id, 45, 'falta mais recente primeiro');
  });

  it('o mesmo cartão aparece uma vez só', () => {
    const g = montarGrupos([cand('sem-resposta', 1, 1), cand('retomar', 1, 1), cand('retomar', 1, 2)]);
    assert.equal(g.reduce((s, x) => s + x.total, 0), 1);
    assert.equal(g[0].total, 1);
  });
});
