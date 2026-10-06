import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidirPagamentoAntecipado,
  ehRegraDeQualificacao,
  escolherCampoDeQualificacao,
  jaEstaQuente,
  opcaoQuente,
  valorDoCampo,
} from './carimbos-do-agendamento.js';
import { pagouOAntecipado } from '../lib/follow-up-worker.js';

const QUALIF_NOME = '★ Qualificação (Quente/Morno/Frio)';
const OPCOES = [
  { id: 11, value: 'Quente' },
  { id: 12, value: 'Morno' },
  { id: 13, value: 'Frio' },
];

function regra(p: Partial<{ kommoFieldId: number; kommoFieldName: string; kommoFieldType: string; kommoFieldEnums: unknown; enabled: boolean }>) {
  return { kommoFieldId: 1, kommoFieldName: 'Campo', kommoFieldType: 'select', kommoFieldEnums: null, enabled: true, ...p } as never;
}

describe('ehRegraDeQualificacao', () => {
  it('é a temperatura, não a data nem o resultado', () => {
    assert.equal(ehRegraDeQualificacao(QUALIF_NOME), true);
    assert.equal(ehRegraDeQualificacao('◷ Data da qualificação'), false);
    assert.equal(ehRegraDeQualificacao('Resultado da qualificação'), false);
    assert.equal(ehRegraDeQualificacao('Motivo da qualificação'), false);
  });
});

describe('escolherCampoDeQualificacao', () => {
  it('prefere a regra da unidade (a mesma da registrar_campo)', () => {
    const c = escolherCampoDeQualificacao(
      [regra({ kommoFieldId: 900, kommoFieldName: QUALIF_NOME, kommoFieldEnums: OPCOES })],
      [{ id: 555, name: QUALIF_NOME, type: 'select', enums: OPCOES }],
    );
    assert.equal(c?.id, 900);
    assert.equal(c?.fonte, 'regra');
  });

  it('sem regra, acha pelo NOME no cartão da conta', () => {
    const c = escolherCampoDeQualificacao(
      [regra({ kommoFieldName: '⚥ Sexo' })],
      [
        { id: 1, name: '◷ Data da qualificação', type: 'date' },
        { id: 2, name: '✎ Queixa', type: 'textarea' },
        { id: 3, name: QUALIF_NOME, type: 'select', enums: OPCOES },
      ],
    );
    assert.equal(c?.id, 3);
    assert.equal(c?.fonte, 'conta');
  });

  it('ignora regra desligada e campo que não é select', () => {
    const c = escolherCampoDeQualificacao(
      [regra({ kommoFieldId: 9, kommoFieldName: QUALIF_NOME, kommoFieldEnums: OPCOES, enabled: false })],
      [{ id: 4, name: 'Qualificação (texto)', type: 'text' }],
    );
    assert.equal(c, null);
  });

  it('entre dois candidatos, fica com o que tem a opção Quente', () => {
    const c = escolherCampoDeQualificacao(
      [
        regra({ kommoFieldId: 7, kommoFieldName: 'Qualificação SDR', kommoFieldEnums: [{ id: 1, value: 'A' }, { id: 2, value: 'B' }] }),
        regra({ kommoFieldId: 8, kommoFieldName: QUALIF_NOME, kommoFieldEnums: OPCOES }),
      ],
      [],
    );
    assert.equal(c?.id, 8);
  });
});

describe('opcaoQuente', () => {
  it('resolve o rótulo exato da conta, inclusive com emoji', () => {
    assert.equal(opcaoQuente({ nome: QUALIF_NOME, tipo: 'select', enums: OPCOES }), 'Quente');
    assert.equal(
      opcaoQuente({ nome: QUALIF_NOME, tipo: 'select', enums: [{ id: 1, value: 'Quente 🔥' }, { id: 2, value: 'Frio ❄️' }] }),
      'Quente 🔥',
    );
  });
  it('sem opções conhecidas manda o rótulo puro; sem Quente entre as opções, null', () => {
    assert.equal(opcaoQuente({ nome: QUALIF_NOME, tipo: 'select', enums: [] }), 'Quente');
    assert.equal(opcaoQuente({ nome: 'Qualificação', tipo: 'select', enums: [{ id: 1, value: 'A' }] }), null);
  });
});

describe('jaEstaQuente / valorDoCampo', () => {
  const lead = {
    custom_fields_values: [
      { field_id: 3, values: [{ value: 'Quente 🔥' }] },
      { field_id: 4, values: [{ value: 'Morno' }] },
      { field_id: 5, values: [{ value: '' }] },
    ],
  };
  it('só pula o PATCH quando já está Quente', () => {
    assert.equal(jaEstaQuente(lead, 3), true);
    assert.equal(jaEstaQuente(lead, 4), false); // Morno → sobrescreve
    assert.equal(jaEstaQuente(lead, 99), false); // vazio → grava
    assert.equal(jaEstaQuente(null, 3), false);
  });
  it('valor vazio conta como ausente', () => {
    assert.equal(valorDoCampo(lead, 5), null);
    assert.equal(valorDoCampo(lead, 4), 'Morno');
    assert.equal(valorDoCampo(lead, null), null);
  });
});

describe('decidirPagamentoAntecipado', () => {
  const base = { ehRetorno: false, pagamentoComprovado: false };

  it('o caso de 06/10 (lead 28088906): escolheu pagar na clínica → Não', () => {
    assert.equal(decidirPagamentoAntecipado({ ...base, formaPagamento: 'na_clinica' }).valor, 'Não');
  });

  it('escolheu Pix antecipado → Sim', () => {
    assert.equal(decidirPagamentoAntecipado({ ...base, formaPagamento: 'pix_antecipado' }).valor, 'Sim');
  });

  it('retorno pós-tratamento → Não, mesmo escolhendo Pix', () => {
    assert.equal(
      decidirPagamentoAntecipado({ ...base, ehRetorno: true, formaPagamento: 'pix_antecipado', pagamentoComprovado: true }).valor,
      'Não',
    );
  });

  it('unidade com taxa de reserva: só reserva com prova, então Sim', () => {
    assert.equal(decidirPagamentoAntecipado({ ...base, pagamentoComprovado: true, formaPagamento: 'na_clinica' }).valor, 'Sim');
  });

  it('remarcação usa a escolha guardada na conversa', () => {
    assert.equal(decidirPagamentoAntecipado({ ...base, escolhaSalva: 'pix_antecipado' }).valor, 'Sim');
    assert.equal(decidirPagamentoAntecipado({ ...base, escolhaSalva: 'na_clinica', valorAtual: 'Sim' }).valor, 'Não');
  });

  it('a forma da chamada ganha da escolha guardada', () => {
    assert.equal(decidirPagamentoAntecipado({ ...base, formaPagamento: 'na_clinica', escolhaSalva: 'pix_antecipado' }).valor, 'Não');
  });

  it('sem sinal: cartão preenchido não é mexido; vazio vira Não', () => {
    assert.equal(decidirPagamentoAntecipado({ ...base, valorAtual: 'Sim' }).valor, null);
    assert.equal(decidirPagamentoAntecipado({ ...base, valorAtual: null }).valor, 'Não');
    assert.equal(decidirPagamentoAntecipado({ ...base, valorAtual: '  ' }).valor, 'Não');
  });

  it('"¤ Pagamento antecipado" continua sem contar como prova para o follow-up', () => {
    // O campo que este módulo escreve NÃO é o que a régua lê como pagamento feito.
    assert.equal(pagouOAntecipado([{ field_name: '¤ Pagamento antecipado', values: [{ value: 'Sim' }] }]), false);
  });
});
